/**
 * Small, dependency-free raw DEFLATE decoder for `.pop` entries.
 * Supports stored, fixed-Huffman and dynamic-Huffman blocks (RFC 1951).
 */

class BitReader {
  private byteOffset = 0;
  private bitOffset = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readBit(): number {
    if (this.byteOffset >= this.data.length) throw new Error("Unexpected end of DEFLATE stream");
    const bit = (this.data[this.byteOffset]! >>> this.bitOffset) & 1;
    this.bitOffset += 1;
    if (this.bitOffset === 8) {
      this.bitOffset = 0;
      this.byteOffset += 1;
    }
    return bit;
  }

  readBits(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) value |= this.readBit() << index;
    return value;
  }

  alignToByte(): void {
    if (this.bitOffset !== 0) {
      this.bitOffset = 0;
      this.byteOffset += 1;
    }
  }

  readByte(): number {
    this.alignToByte();
    if (this.byteOffset >= this.data.length) throw new Error("Unexpected end of DEFLATE stored block");
    return this.data[this.byteOffset++]!;
  }

  readUint16(): number {
    const low = this.readByte();
    const high = this.readByte();
    return low | (high << 8);
  }
}

interface HuffmanTable {
  codes: Map<number, number>[];
  maxBits: number;
}

function buildHuffman(lengths: number[]): HuffmanTable {
  let maxBits = 0;
  for (const length of lengths) {
    if (length > maxBits) maxBits = length;
  }
  const counts = new Array(maxBits + 1).fill(0);
  for (const length of lengths) if (length > 0) counts[length] += 1;
  const next = new Array(maxBits + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits += 1) {
    code = (code + counts[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = Array.from({ length: maxBits + 1 }, () => new Map<number, number>());
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol]!;
    if (length === 0) continue;
    codes[length]!.set(next[length]!, symbol);
    next[length] += 1;
  }
  return { codes, maxBits };
}

function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  let code = 0;
  for (let length = 1; length <= table.maxBits; length += 1) {
    code = (code << 1) | reader.readBit();
    const symbol = table.codes[length]!.get(code);
    if (symbol !== undefined) return symbol;
  }
  throw new Error("Invalid DEFLATE Huffman code");
}

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

function fixedTables(): { literals: HuffmanTable; distances: HuffmanTable } {
  const literalLengths: number[] = [];
  for (let symbol = 0; symbol <= 287; symbol += 1) {
    literalLengths.push(symbol <= 143 ? 8 : symbol <= 255 ? 9 : symbol <= 279 ? 7 : 8);
  }
  return {
    literals: buildHuffman(literalLengths),
    distances: buildHuffman(new Array(32).fill(5)),
  };
}

function dynamicTables(reader: BitReader): { literals: HuffmanTable; distances: HuffmanTable } {
  const literalCount = reader.readBits(5) + 257;
  const distanceCount = reader.readBits(5) + 1;
  const codeLengthCount = reader.readBits(4) + 4;
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const codeLengths = new Array(19).fill(0);
  for (let index = 0; index < codeLengthCount; index += 1) {
    codeLengths[order[index]!] = reader.readBits(3);
  }
  const codeLengthTable = buildHuffman(codeLengths);
  const total = literalCount + distanceCount;
  const lengths: number[] = [];
  while (lengths.length < total) {
    const symbol = decodeSymbol(reader, codeLengthTable);
    if (symbol <= 15) {
      lengths.push(symbol);
    } else if (symbol === 16) {
      if (lengths.length === 0) throw new Error("Invalid DEFLATE repeat code");
      const previous = lengths[lengths.length - 1]!;
      const repeat = reader.readBits(2) + 3;
      for (let index = 0; index < repeat; index += 1) lengths.push(previous);
    } else if (symbol === 17) {
      const repeat = reader.readBits(3) + 3;
      for (let index = 0; index < repeat; index += 1) lengths.push(0);
    } else if (symbol === 18) {
      const repeat = reader.readBits(7) + 11;
      for (let index = 0; index < repeat; index += 1) lengths.push(0);
    } else {
      throw new Error("Invalid DEFLATE code-length symbol");
    }
    if (lengths.length > total) throw new Error("DEFLATE code lengths exceed the block size");
  }
  return {
    literals: buildHuffman(lengths.slice(0, literalCount)),
    distances: buildHuffman(lengths.slice(literalCount)),
  };
}

export function inflateRaw(data: Uint8Array): Uint8Array {
  const reader = new BitReader(data);
  let output = new Uint8Array(1024);
  let outputLength = 0;
  const ensure = (needed: number): void => {
    if (needed <= output.length) return;
    let capacity = output.length;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(output.subarray(0, outputLength));
    output = next;
  };
  const push = (byte: number): void => {
    ensure(outputLength + 1);
    output[outputLength++] = byte & 0xff;
  };

  let final = false;
  while (!final) {
    final = reader.readBit() === 1;
    const type = reader.readBits(2);
    if (type === 0) {
      reader.alignToByte();
      const length = reader.readUint16();
      const inverse = reader.readUint16();
      if (((length ^ inverse) & 0xffff) !== 0xffff) throw new Error("Invalid DEFLATE stored block length");
      ensure(outputLength + length);
      for (let index = 0; index < length; index += 1) output[outputLength++] = reader.readByte();
      continue;
    }
    const tables = type === 1 ? fixedTables() : type === 2 ? dynamicTables(reader) : null;
    if (!tables) throw new Error(`Unsupported DEFLATE block type ${type}`);
    for (;;) {
      const symbol = decodeSymbol(reader, tables.literals);
      if (symbol < 256) {
        push(symbol);
        continue;
      }
      if (symbol === 256) break;
      const lengthIndex = symbol - 257;
      if (lengthIndex < 0 || lengthIndex >= LENGTH_BASE.length) throw new Error("Invalid DEFLATE length symbol");
      const length = LENGTH_BASE[lengthIndex]! + reader.readBits(LENGTH_EXTRA[lengthIndex]!);
      const distanceSymbol = decodeSymbol(reader, tables.distances);
      if (distanceSymbol >= DISTANCE_BASE.length) throw new Error("Invalid DEFLATE distance symbol");
      const distance = DISTANCE_BASE[distanceSymbol]! + reader.readBits(DISTANCE_EXTRA[distanceSymbol]!);
      if (distance > outputLength) throw new Error("Invalid DEFLATE back-reference");
      ensure(outputLength + length);
      for (let index = 0; index < length; index += 1) {
        output[outputLength] = output[outputLength - distance]!;
        outputLength += 1;
      }
    }
  }
  return output.slice(0, outputLength);
}
