/**
 * Dependency-free raw DEFLATE encoder and zlib wrapper.
 *
 * `ByteArray.compress()`/`uncompress()` are synchronous and must work in both the Node and
 * browser builds of the runtime, so `node:zlib` and the async `CompressionStream` cannot back
 * them. The encoder emits fixed-Huffman blocks with greedy LZ77 matching, and falls back to
 * stored blocks when that would be smaller; `inflate.ts` decodes every block type, and its
 * decoder is exercised against this encoder in the runtime tests.
 */

import { inflateRaw } from "./inflate.ts";

const WINDOW_SIZE = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MAX_CHAIN = 96;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const MAX_STORED_BLOCK = 0xffff;

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

class BitWriter {
  private readonly bytes: number[] = [];
  private pending = 0;
  private bitCount = 0;

  /** Writes `count` bits of `value` least-significant bit first (DEFLATE bit order). */
  writeBits(value: number, count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.pending |= ((value >>> index) & 1) << this.bitCount;
      this.bitCount += 1;
      if (this.bitCount === 8) {
        this.bytes.push(this.pending);
        this.pending = 0;
        this.bitCount = 0;
      }
    }
  }

  /** Writes a Huffman code most-significant bit first, as RFC 1951 requires. */
  writeCode(code: number, length: number): void {
    let reversed = 0;
    for (let index = 0; index < length; index += 1) {
      reversed |= ((code >>> index) & 1) << (length - 1 - index);
    }
    this.writeBits(reversed, length);
  }

  finish(): Uint8Array {
    if (this.bitCount > 0) this.bytes.push(this.pending);
    this.pending = 0;
    this.bitCount = 0;
    return Uint8Array.from(this.bytes);
  }
}

/** Fixed-Huffman literal/length code for a symbol (RFC 1951 §3.2.6). */
function fixedCode(symbol: number): { code: number; length: number } {
  if (symbol <= 143) return { code: 0x30 + symbol, length: 8 };
  if (symbol <= 255) return { code: 0x190 + (symbol - 144), length: 9 };
  if (symbol <= 279) return { code: symbol - 256, length: 7 };
  return { code: 0xc0 + (symbol - 280), length: 8 };
}

function lengthCode(length: number): { symbol: number; extra: number; extraBits: number } {
  for (let index = LENGTH_BASE.length - 1; index >= 0; index -= 1) {
    if (length >= LENGTH_BASE[index]!) {
      return {
        symbol: 257 + index,
        extra: length - LENGTH_BASE[index]!,
        extraBits: LENGTH_EXTRA[index]!,
      };
    }
  }
  throw new RangeError(`DEFLATE cannot encode match length ${length}`);
}

function distanceCode(distance: number): { symbol: number; extra: number; extraBits: number } {
  for (let index = DISTANCE_BASE.length - 1; index >= 0; index -= 1) {
    if (distance >= DISTANCE_BASE[index]!) {
      return {
        symbol: index,
        extra: distance - DISTANCE_BASE[index]!,
        extraBits: DISTANCE_EXTRA[index]!,
      };
    }
  }
  throw new RangeError(`DEFLATE cannot encode distance ${distance}`);
}

function hashAt(data: Uint8Array, position: number): number {
  return (((data[position]! << 8) ^ (data[position + 1]! << 4) ^ data[position + 2]!) * 0x9e37) & HASH_MASK;
}

function writeSymbol(writer: BitWriter, symbol: number): void {
  const { code, length } = fixedCode(symbol);
  writer.writeCode(code, length);
}

function writeDistance(writer: BitWriter, symbol: number): void {
  // Fixed distance codes are five-bit values, most-significant bit first.
  writer.writeCode(symbol, 5);
}

/** One final fixed-Huffman block with greedy LZ77 matching. */
function fixedBlock(data: Uint8Array): Uint8Array {
  const writer = new BitWriter();
  writer.writeBits(1, 1);
  writer.writeBits(1, 2);

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const previous = new Int32Array(data.length).fill(-1);

  const insert = (position: number): void => {
    if (position + MIN_MATCH > data.length) return;
    const hash = hashAt(data, position);
    previous[position] = head[hash]!;
    head[hash] = position;
  };

  let position = 0;
  while (position < data.length) {
    let bestLength = 0;
    let bestDistance = 0;
    if (position + MIN_MATCH <= data.length) {
      const limit = Math.min(MAX_MATCH, data.length - position);
      const hash = hashAt(data, position);
      let candidate = head[hash]!;
      let chain = 0;
      while (candidate >= 0 && position - candidate <= WINDOW_SIZE && chain < MAX_CHAIN) {
        let length = 0;
        while (length < limit && data[candidate + length] === data[position + length]) length += 1;
        if (length > bestLength) {
          bestLength = length;
          bestDistance = position - candidate;
          if (length === limit) break;
        }
        candidate = previous[candidate]!;
        chain += 1;
      }
    }

    insert(position);

    if (bestLength >= MIN_MATCH) {
      const match = lengthCode(bestLength);
      writeSymbol(writer, match.symbol);
      writer.writeBits(match.extra, match.extraBits);
      const distance = distanceCode(bestDistance);
      writeDistance(writer, distance.symbol);
      writer.writeBits(distance.extra, distance.extraBits);
      for (let offset = 1; offset < bestLength; offset += 1) insert(position + offset);
      position += bestLength;
    } else {
      writeSymbol(writer, data[position]!);
      position += 1;
    }
  }

  writeSymbol(writer, 256);
  return writer.finish();
}

/** Stored blocks; always byte-aligned and never larger than the input by more than framing. */
function storedBlock(data: Uint8Array): Uint8Array {
  const chunks = Math.max(1, Math.ceil(data.length / MAX_STORED_BLOCK));
  const output: number[] = [];
  for (let index = 0; index < chunks; index += 1) {
    const start = index * MAX_STORED_BLOCK;
    const chunk = data.subarray(start, Math.min(data.length, start + MAX_STORED_BLOCK));
    // BFINAL in bit 0, BTYPE 00 in bits 1-2; every stored block starts byte-aligned.
    output.push(index === chunks - 1 ? 1 : 0);
    const length = chunk.length;
    output.push(length & 0xff, (length >>> 8) & 0xff, ~length & 0xff, (~length >>> 8) & 0xff);
    for (const byte of chunk) output.push(byte);
  }
  return Uint8Array.from(output);
}

export function deflateRaw(data: Uint8Array): Uint8Array {
  const fixed = fixedBlock(data);
  const stored = storedBlock(data);
  return fixed.length <= stored.length ? fixed : stored;
}

export function adler32(data: Uint8Array): number {
  let low = 1;
  let high = 0;
  for (const byte of data) {
    low = (low + byte) % 65521;
    high = (high + low) % 65521;
  }
  return ((high << 16) | low) >>> 0;
}

export function zlibCompress(data: Uint8Array): Uint8Array {
  const raw = deflateRaw(data);
  const output = new Uint8Array(raw.length + 6);
  output[0] = 0x78;
  output[1] = 0x9c;
  output.set(raw, 2);
  const sum = adler32(data);
  output[output.length - 4] = (sum >>> 24) & 0xff;
  output[output.length - 3] = (sum >>> 16) & 0xff;
  output[output.length - 2] = (sum >>> 8) & 0xff;
  output[output.length - 1] = sum & 0xff;
  return output;
}

/** Decodes a zlib stream (the wrapper `ByteArray.compress` produces by default). */
export function zlibDecompress(data: Uint8Array): Uint8Array {
  if (data.length < 6) throw new Error("Truncated zlib stream");
  const cmf = data[0]!;
  const flg = data[1]!;
  if ((cmf & 0x0f) !== 8) throw new Error("Unsupported zlib compression method");
  if (((cmf << 8) + flg) % 31 !== 0) throw new Error("Invalid zlib header check");
  if ((flg & 0x20) !== 0) throw new Error("Preset zlib dictionaries are not supported");
  const raw = inflateRaw(data.subarray(2, data.length - 4));
  const expected =
    ((data[data.length - 4]! << 24) |
      (data[data.length - 3]! << 16) |
      (data[data.length - 2]! << 8) |
      data[data.length - 1]!) >>>
    0;
  if (adler32(raw) !== expected) throw new Error("zlib checksum mismatch");
  return raw;
}
