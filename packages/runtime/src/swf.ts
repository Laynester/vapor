/**
 * Minimal SWF reader for asset-library SWFs.
 *
 * It reads the tag stream, not AVM2 bytecode. The only data extracted is what the
 * runtime AssetLibrary path needs: SymbolClass names, DefineBinaryData payloads and
 * lossless/JPEG bitmap symbols. AVM2 code in a loaded SWF is intentionally ignored.
 */

import { inflateRaw } from "../../shared/src/inflate.ts";

const TAG_END = 0;
const TAG_DEFINE_BITS_JPEG2 = 21;
const TAG_DEFINE_BITS_LOSSLESS = 20;
const TAG_DEFINE_BITS_LOSSLESS2 = 36;
const TAG_DEFINE_BITS_JPEG3 = 35;
const TAG_DEFINE_BITS_JPEG4 = 90;
const TAG_SYMBOL_CLASS = 76;
const TAG_DEFINE_BINARY_DATA = 87;

export interface SwfImage {
  width: number;
  height: number;
  pixels?: Uint32Array;
  bytes?: Uint8Array;
  mimeType?: string;
}

export interface SwfSymbol {
  characterId: number;
  className?: string;
  kind: "binary" | "image" | "shape";
  bytes?: Uint8Array;
  image?: SwfImage;
}

export interface SwfLibrary {
  version: number;
  symbols: SwfSymbol[];
  manifest: Uint8Array | null;
}

interface Character {
  kind: "binary" | "image" | "shape";
  bytes?: Uint8Array;
  image?: SwfImage;
}

function inflate(data: Uint8Array): Uint8Array {
  if (data.length < 6) throw new Error("Truncated zlib stream");
  // SWF and bitmap tags use a zlib wrapper; the runtime inflater handles raw DEFLATE.
  return inflateRaw(data.subarray(2, data.length - 4));
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function readU16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

function isXmlBytes(bytes: Uint8Array): boolean {
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  while (offset < bytes.length && (bytes[offset] === 0x20 || bytes[offset] === 0x0a || bytes[offset] === 0x0d || bytes[offset] === 0x09)) {
    offset += 1;
  }
  return bytes[offset] === 0x3c; // '<'
}

function decodeLossless(data: Uint8Array, withAlpha: boolean): SwfImage {
  let offset = 0;
  const characterId = readU16(data, offset);
  offset += 2;
  const format = data[offset++]!;
  const width = readU16(data, offset);
  offset += 2;
  const height = readU16(data, offset);
  offset += 2;
  if (width === 0 || height === 0 || characterId === 0) {
    throw new Error("Invalid lossless bitmap dimensions");
  }

  let palette: Uint32Array | null = null;
  if (format === 3) {
    const paletteSize = data[offset++]! + 1;
    palette = new Uint32Array(paletteSize);
    const components = withAlpha ? 4 : 3;
    for (let index = 0; index < paletteSize; index += 1) {
      const base = offset + index * components;
      if (base + components > data.length) throw new Error("Truncated lossless palette");
      const alpha = withAlpha ? data[base]! : 0xff;
      const red = data[base + (withAlpha ? 1 : 0)]!;
      const green = data[base + (withAlpha ? 2 : 1)]!;
      const blue = data[base + (withAlpha ? 3 : 2)]!;
      palette[index] = ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0;
    }
    offset += paletteSize * components;
  } else if (format !== 5) {
    throw new Error(`Unsupported lossless bitmap format ${format}`);
  }

  const raw = inflate(data.subarray(offset));
  const pixels = new Uint32Array(width * height);
  if (format === 5) {
    // Format 5 is 32-bit per pixel for both tags; DefineBitsLossless ignores the
    // first (alpha) byte while DefineBitsLossless2 uses it.
    const components = 4;
    const needed = width * height * components;
    if (raw.length < needed) throw new Error("Truncated lossless bitmap data");
    for (let index = 0; index < pixels.length; index += 1) {
      const base = index * components;
      const alpha = withAlpha ? raw[base]! : 0xff;
      const red = raw[base + 1]!;
      const green = raw[base + 2]!;
      const blue = raw[base + 3]!;
      pixels[index] = ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0;
    }
  } else {
    const rowBytes = (width + 3) & ~3;
    if (raw.length < rowBytes * height) throw new Error("Truncated indexed bitmap data");
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const paletteIndex = raw[y * rowBytes + x]!;
        pixels[y * width + x] = palette?.[paletteIndex] ?? 0;
      }
    }
  }
  return { width, height, pixels };
}

function jpegMimeType(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return "application/octet-stream";
}

function readSymbolClasses(data: Uint8Array): Map<number, string> {
  const symbols = new Map<number, string>();
  const count = readU16(data, 0);
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    if (offset + 2 > data.length) throw new Error("Truncated SymbolClass");
    const characterId = readU16(data, offset);
    offset += 2;
    const start = offset;
    while (offset < data.length && data[offset] !== 0) offset += 1;
    if (offset >= data.length) throw new Error("Unterminated SymbolClass name");
    symbols.set(characterId, decodeUtf8(data.subarray(start, offset)));
    offset += 1;
  }
  return symbols;
}

/** Parses an FWS/CWS SWF. ZWS is rejected because the runtime has no LZMA decoder. */
export function parseSwf(bytes: Uint8Array): SwfLibrary {
  if (bytes.length < 8) throw new Error("Truncated SWF header");
  const signature = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!);
  if (signature !== "FWS" && signature !== "CWS") {
    if (signature === "ZWS") throw new Error("ZWS (LZMA) SWFs are not supported");
    throw new Error(`Unsupported SWF signature '${signature}'`);
  }
  const version = bytes[3]!;
  let body: Uint8Array;
  if (signature === "CWS") {
    body = inflate(bytes.subarray(8));
  } else {
    body = bytes.subarray(8);
  }
  if (body.length < 1) throw new Error("Truncated SWF body");

  // SWF bit-packed fields are MSB-first: the RECT's first 5 bits are Nbits.
  const rectBits = body[0]! >> 3;
  let offset = Math.ceil((5 + rectBits * 4) / 8) + 4; // RECT + frame rate + frame count
  const characters = new Map<number, Character>();
  const symbols = new Map<number, string>();

  while (offset + 2 <= body.length) {
    // TagCodeAndLength: bits 6-15 are the tag code, bits 0-5 the length (0x3f = long form).
    const header = readU16(body, offset);
    offset += 2;
    const code = header >> 6;
    let length = header & 0x3f;
    if (length === 0x3f) {
      if (offset + 4 > body.length) throw new Error("Truncated long SWF tag");
      length = readU32(body, offset);
      offset += 4;
    }
    if (offset + length > body.length) throw new Error(`Truncated SWF tag ${code}`);
    const data = body.subarray(offset, offset + length);
    offset += length;
    if (code === TAG_END) break;

    if (code === TAG_SYMBOL_CLASS) {
      for (const [characterId, name] of readSymbolClasses(data)) symbols.set(characterId, name);
      continue;
    }
    if (code === TAG_DEFINE_BINARY_DATA) {
      if (data.length < 6) throw new Error("Truncated DefineBinaryData");
      characters.set(readU16(data, 0), { kind: "binary", bytes: data.subarray(6) });
      continue;
    }
    if (code === TAG_DEFINE_BITS_LOSSLESS || code === TAG_DEFINE_BITS_LOSSLESS2) {
      characters.set(readU16(data, 0), {
        kind: "image",
        image: decodeLossless(data, code === TAG_DEFINE_BITS_LOSSLESS2),
      });
      continue;
    }
    if (code === TAG_DEFINE_BITS_JPEG2 || code === TAG_DEFINE_BITS_JPEG3 || code === TAG_DEFINE_BITS_JPEG4) {
      if (data.length < 2) throw new Error("Truncated JPEG bitmap tag");
      // JPEG3/JPEG4 prepend an alpha offset (the image length); JPEG2 has no alpha.
      const withAlpha = code === TAG_DEFINE_BITS_JPEG3 || code === TAG_DEFINE_BITS_JPEG4;
      const imageOffset = withAlpha ? 6 : 2;
      if (data.length < imageOffset) throw new Error("Truncated JPEG bitmap tag");
      const imageLength = withAlpha
        ? Math.min(readU32(data, 2), data.length - imageOffset)
        : data.length - imageOffset;
      const imageBytes = data.subarray(imageOffset, imageOffset + imageLength);
      characters.set(readU16(data, 0), {
        kind: "image",
        image: { width: 0, height: 0, bytes: imageBytes, mimeType: jpegMimeType(imageBytes) },
      });
    }
  }

  let manifest: Uint8Array | null = null;
  let namedManifest: Uint8Array | null = null;
  for (const [characterId, character] of characters) {
    if (character.kind !== "binary" || !character.bytes || !isXmlBytes(character.bytes)) continue;
    if (/manifest/i.test(symbols.get(characterId) ?? "")) {
      namedManifest = character.bytes;
      break;
    }
    manifest ??= character.bytes;
  }
  manifest = namedManifest ?? manifest;

  const result: SwfSymbol[] = [];
  for (const [characterId, className] of symbols) {
    const character = characters.get(characterId);
    if (character) result.push({ characterId, className, ...character });
  }
  for (const [characterId, character] of characters) {
    if (!symbols.has(characterId)) result.push({ characterId, ...character });
  }
  return { version, symbols: result, manifest };
}
