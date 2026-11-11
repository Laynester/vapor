/** Deterministic `.pop` ZIP writer/reader for non-code assets. */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { inflateRaw } from "../../../shared/src/inflate.ts";

export type PopCompression = "store" | "deflate" | "auto";

export interface PopAsset {
  name: string;
  source: string;
  entry: string;
  mime: string;
  kind: "bitmap" | "text" | "xml" | "sound" | "font" | "binary";
  size: number;
  sha256: string;
  aliases: string[];
  compression: "store" | "deflate";
}

export interface PopManifest {
  format: "as3js-pop";
  version: 1;
  abi: 1;
  bundle: string;
  compiler: string;
  created: string;
  modules: string[];
  dependencies: string[];
  assets: PopAsset[];
}

export interface PopInputFile {
  source: string;
  data: Uint8Array;
}

export interface PopArchive {
  bytes: Uint8Array;
  manifest: PopManifest;
  entries: Map<string, Uint8Array>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function mimeFor(extension: string): string {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".xml": "application/xml",
    ".txt": "text/plain",
    ".json": "application/json",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".bin": "application/octet-stream",
  };
  return types[extension] ?? "application/octet-stream";
}

function kindFor(extension: string): PopAsset["kind"] {
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg"].includes(extension)) return "bitmap";
  if (extension === ".xml") return "xml";
  if ([".txt", ".json", ".html", ".css"].includes(extension)) return "text";
  if ([".mp3", ".wav"].includes(extension)) return "sound";
  if ([".ttf", ".otf"].includes(extension)) return "font";
  return "binary";
}

function decodeManifestText(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function decodeManifestEntity(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Reads `<asset name="...">` entries from a module manifest without deriving names. */
function manifestLogicalNames(data: Uint8Array): string[] {
  const source = decodeManifestText(data);
  const names: string[] = [];
  const pattern = /<asset\b[^>]*\bname\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = decodeManifestEntity(match[1]!);
    if (name.length > 0 && !names.includes(name)) names.push(name);
  }
  return names;
}

function manifestPrefix(source: string): string | null {
  const filename = basename(source);
  if (!filename.endsWith("_manifest.bin")) return null;
  return filename.slice(0, -"_manifest.bin".length);
}

/**
 * Module manifests name assets logically; the generated asset for a module is
 * `<module>_<logicalName>.<ext>`. Only unique matches become aliases. Ambiguous
 * names stay explicit so a manifest lookup cannot silently select the wrong asset.
 */
function manifestAliases(files: readonly PopInputFile[]): Map<string, string[]> {
  const byExtensionlessName = new Map<string, string[]>();
  for (const file of files) {
    const key = basename(file.source, extname(file.source));
    const sources = byExtensionlessName.get(key) ?? [];
    sources.push(file.source);
    byExtensionlessName.set(key, sources);
  }
  const owners = new Map<string, Set<string>>();
  for (const file of files) {
    const prefix = manifestPrefix(file.source);
    if (!prefix) continue;
    for (const name of manifestLogicalNames(file.data)) {
      const candidates = byExtensionlessName.get(`${prefix}_${name}`) ?? [];
      if (candidates.length !== 1) continue;
      const sources = owners.get(name) ?? new Set<string>();
      sources.add(candidates[0]!);
      owners.set(name, sources);
    }
  }
  const aliases = new Map<string, string[]>();
  for (const [name, sources] of owners) {
    if (sources.size !== 1) continue;
    const source = sources.values().next().value as string;
    const names = aliases.get(source) ?? [];
    names.push(name);
    aliases.set(source, names);
  }
  return aliases;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
  uncompressedSize: number;
  method: 0 | 8;
  crc: number;
}

function writeLocalHeader(name: Buffer, data: Buffer, crc: number, method: 0 | 8, uncompressedSize: number): Buffer {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function writeCentralHeader(name: Buffer, data: Buffer, crc: number, method: 0 | 8, uncompressedSize: number, localOffset: number): Buffer {
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x21, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);
  name.copy(header, 46);
  return header;
}

function zipEntry(name: string, source: Uint8Array, compression: PopCompression): ZipEntry {
  const raw = Buffer.from(source);
  const compressed = compression === "store" ? raw : Buffer.from(deflateRawSync(raw));
  const method: 0 | 8 = compression !== "store" && compressed.length < raw.length ? 8 : 0;
  return {
    name,
    data: method === 8 ? new Uint8Array(compressed) : source,
    uncompressedSize: raw.length,
    method,
    crc: crc32(raw),
  };
}

function buildZip(entries: ReadonlyArray<ZipEntry>): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const local = writeLocalHeader(name, data, entry.crc, entry.method, entry.uncompressedSize);
    localParts.push(local, data);
    centralParts.push(writeCentralHeader(name, data, entry.crc, entry.method, entry.uncompressedSize, offset));
    offset += local.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...localParts, ...centralParts, end]));
}

export function buildPop(
  files: readonly PopInputFile[],
  options: {  bundle?: string;
  compiler?: string;
  compression?: PopCompression;
  dependencies?: string[];
  modules?: string[];
} = {},
): PopArchive {
  const compression = options.compression ?? "store";
  const entries = new Map<string, Uint8Array>();
  const assets: PopAsset[] = [];
  const byEntry = new Map<string, PopAsset>();
  const bySource = new Map<string, PopAsset>();

  for (const file of [...files].sort((a, b) => a.source.localeCompare(b.source))) {
    const data = file.data;
    const digest = sha256(data);
    const extension = extname(file.source).toLowerCase();
    const entry = `assets/${digest}${extension}`;
    if (!byEntry.has(entry)) {
      const asset: PopAsset = {
        name: file.source,
        source: file.source,
        entry,
        mime: mimeFor(extension),
        kind: kindFor(extension),
        size: data.length,
        sha256: digest,
        aliases: [],
        compression: "store",
      };
      byEntry.set(entry, asset);
      bySource.set(file.source, asset);
      assets.push(asset);
      entries.set(entry, data);
    } else {
      const existing = byEntry.get(entry)!;
      existing.aliases.push(file.source);
      bySource.set(file.source, existing);
    }
  }

  assets.sort((a, b) => a.source.localeCompare(b.source));
  // Count basenames across every input file, not only the asset chosen as the
  // content-addressed owner. Identical files deduplicate to one entry but must
  // still retain their own basename aliases for `[Embed(source="name")]`.
  const basenameCounts = new Map<string, number>();
  for (const file of files) {
    const name = basename(file.source);
    basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
  }
  for (const file of files) {
    const asset = bySource.get(file.source);
    if (!asset) continue;
    const name = basename(file.source);
    if (name !== file.source && name !== asset.name && basenameCounts.get(name) === 1 && !asset.aliases.includes(name)) {
      asset.aliases.push(name);
    }
  }
  for (const asset of assets) asset.aliases.sort();
  for (const [source, names] of manifestAliases(files)) {
    const asset = bySource.get(source);
    if (!asset) continue;
    for (const name of names) {
      const owner = assets.find((candidate) =>
        candidate.name === name || candidate.source === name || candidate.aliases.includes(name));
      if (!owner && !asset.aliases.includes(name)) asset.aliases.push(name);
    }
    asset.aliases.sort();
  }
  const manifest: PopManifest = {
    format: "as3js-pop",
    version: 1,
    abi: 1,
    bundle: options.bundle ?? "app",
    compiler: options.compiler ?? "0.0.0",
    created: "1980-01-01T00:00:00Z",
    modules: options.modules ?? [],
    dependencies: options.dependencies ?? [],
    assets,
  };
  const ordered: ZipEntry[] = [...entries.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, data]) => zipEntry(name, data, compression));
  const byZipName = new Map(ordered.map((entry) => [entry.name, entry]));
  for (const asset of assets) {
    asset.compression = byZipName.get(asset.entry)?.method === 8 ? "deflate" : "store";
  }
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  ordered.unshift(zipEntry("pop.json", manifestBytes, "store"));
  return { bytes: buildZip(ordered), manifest, entries };
}

function collectFiles(root: string, directory: string, out: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(root, full, out);
    else if (entry.isFile()) out.push(full);
  }
}

export function buildPopSet(
  files: readonly PopInputFile[],
  options: {
    baseBundle?: string;
    compiler?: string;
    compression?: PopCompression;
    maxAssetsPerBundle?: number;
    maxBundleBytes?: number;
  } = {},
): PopArchive[] {
  const sorted = [...files].sort((a, b) => a.source.localeCompare(b.source));
  const groups: PopInputFile[][] = [];
  let current: PopInputFile[] = [];
  let currentBytes = 0;
  const maxAssets = Math.max(1, options.maxAssetsPerBundle ?? 1024);
  const maxBytes = Math.max(1, options.maxBundleBytes ?? Number.MAX_SAFE_INTEGER);
  for (const file of sorted) {
    if (current.length > 0 && (current.length >= maxAssets || currentBytes + file.data.length > maxBytes)) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.data.length;
  }
  if (current.length > 0) groups.push(current);
  const base = options.baseBundle ?? "app";
  if (groups.length === 0) {
    return [buildPop([], {
      bundle: base,
      ...(options.compiler ? { compiler: options.compiler } : {}),
      ...(options.compression ? { compression: options.compression } : {}),
    })];
  }
  return groups.map((group, index) => {
    const bundle = index === 0 ? base : `${base}-${index + 1}`;
    return buildPop(group, {
      bundle,
      ...(options.compiler ? { compiler: options.compiler } : {}),
      ...(options.compression ? { compression: options.compression } : {}),
      dependencies: index === 0 ? [] : [base],
    });
  });
}

export function createPopFromDirectory(
  directory: string,
  options: { bundle?: string; compiler?: string; compression?: PopCompression } = {},
): PopArchive {
  const files: string[] = [];
  collectFiles(directory, directory, files);
  return buildPop(
    files.map((file) => ({
      source: relative(directory, file).split(sep).join("/"),
      data: readFileSync(file),
    })),
    options,
  );
}

/** Reads a `.pop` archive; used by build validation and tests. */
export function readPopArchive(bytes: Uint8Array): { manifest: PopManifest; entries: Map<string, Uint8Array> } {
  const buffer = Buffer.from(bytes);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("Invalid .pop archive: end of central directory not found");
  const count = buffer.readUInt16LE(endOffset + 10);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid .pop central directory");
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported .pop compression method ${method} for ${name}`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid .pop local header for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRaw(compressed) : compressed;
    if (data.length !== uncompressedSize) throw new Error(`Size mismatch in .pop entry ${name}`);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in .pop entry ${name}`);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  const manifestBytes = entries.get("pop.json");
  if (!manifestBytes) throw new Error("Invalid .pop archive: pop.json is missing");
  return { manifest: JSON.parse(new TextDecoder().decode(manifestBytes)) as PopManifest, entries };
}
