/**
 * Synchronous PNG decoder for embedded assets.
 *
 * Flash exposes `[Embed]` bitmaps with their pixels ready the moment the class is
 * constructed: the window manager parses skin templates and copies pixels out of them
 * immediately. `createImageBitmap` is asynchronous, so that path has to fall back to
 * this decoder to avoid caching blank skins.
 */

import { inflateRaw } from "../../shared/src/inflate.ts";

export interface DecodedPng {
  width: number;
  height: number;
  /** Straight (non-premultiplied) ARGB, matching `BitmapDataState.pixels`. */
  pixels: Uint32Array;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Reverses one PNG scanline filter in place; `bpp` is the byte distance to the left pixel. */
function unfilter(type: number, line: Uint8Array, previous: Uint8Array, bpp: number): void {
  switch (type) {
    case 0:
      return;
    case 1:
      for (let index = bpp; index < line.length; index += 1) {
        line[index] = (line[index]! + line[index - bpp]!) & 0xff;
      }
      return;
    case 2:
      for (let index = 0; index < line.length; index += 1) {
        line[index] = (line[index]! + previous[index]!) & 0xff;
      }
      return;
    case 3:
      for (let index = 0; index < line.length; index += 1) {
        const left = index >= bpp ? line[index - bpp]! : 0;
        line[index] = (line[index]! + ((left + previous[index]!) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let index = 0; index < line.length; index += 1) {
        const left = index >= bpp ? line[index - bpp]! : 0;
        const above = previous[index]!;
        const upperLeft = index >= bpp ? previous[index - bpp]! : 0;
        const estimate = left + above - upperLeft;
        const distanceLeft = Math.abs(estimate - left);
        const distanceAbove = Math.abs(estimate - above);
        const distanceUpperLeft = Math.abs(estimate - upperLeft);
        const predictor =
          distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft
            ? left
            : distanceAbove <= distanceUpperLeft
              ? above
              : upperLeft;
        line[index] = (line[index]! + predictor) & 0xff;
      }
      return;
    default:
      throw new Error(`Unknown PNG filter type ${type}`);
  }
}

function channelsFor(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return 0;
  }
}

/**
 * Decodes an 8-bit, non-interlaced PNG (grayscale, RGB, grayscale+alpha or RGBA).
 * Returns `null` for anything else so the caller can use the async host decoder.
 */
export function decodePng(bytes: Uint8Array): DecodedPng | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33) return null;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return null;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const data: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    const start = offset + 8;
    if (start + length + 4 > bytes.length) return null;
    if (type === "IHDR" && length >= 13) {
      width = readUint32(bytes, start);
      height = readUint32(bytes, start + 4);
      bitDepth = bytes[start + 8]!;
      colorType = bytes[start + 9]!;
      interlace = bytes[start + 12]!;
    } else if (type === "IDAT") {
      data.push(bytes.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }

  const channels = channelsFor(colorType);
  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0 || channels === 0 || data.length === 0) {
    return null;
  }

  const compressed = concatenate(data);
  // PNG data is zlib-wrapped: a two-byte header and a four-byte Adler-32 trailer.
  if (compressed.length <= 6) return null;
  let raw: Uint8Array;
  try {
    raw = inflateRaw(compressed.subarray(2, compressed.length - 4));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const pixels = new Uint32Array(width * height);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position]!;
    position += 1;
    current.set(raw.subarray(position, position + stride));
    position += stride;
    try {
      unfilter(filter, current, previous, channels);
    } catch {
      return null;
    }
    for (let x = 0; x < width; x += 1) {
      const index = x * channels;
      let red = current[index]!;
      let green = red;
      let blue = red;
      let alpha = 255;
      if (channels === 2) {
        alpha = current[index + 1]!;
      } else if (channels === 3) {
        green = current[index + 1]!;
        blue = current[index + 2]!;
      } else if (channels === 4) {
        green = current[index + 1]!;
        blue = current[index + 2]!;
        alpha = current[index + 3]!;
      }
      pixels[y * width + x] = ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  return { width, height, pixels };
}
