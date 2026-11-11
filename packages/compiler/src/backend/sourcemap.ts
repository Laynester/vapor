/** Minimal Source Map v3 encoding for generated module files. */

import type { Span } from "../diagnostics.ts";

export interface SourceMapping {
  /** 1-based generated line. */
  generatedLine: number;
  /** 0-based generated column. */
  generatedColumn: number;
  source: string;
  /** 1-based source line. */
  line: number;
  /** 0-based source column. */
  column: number;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeVlq(value: number): string {
  let remaining = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let encoded = "";
  do {
    let digit = remaining & 31;
    remaining >>>= 5;
    if (remaining > 0) digit |= 32;
    encoded += BASE64[digit]!;
  } while (remaining > 0);
  return encoded;
}

/**
 * Writes a standard Source Map v3. Mappings are coarse (declaration-level), but they
 * resolve generated module lines back to the original AS3 source and include sourceContent.
 */
export function createSourceMap(
  file: string,
  sourcesContent: ReadonlyMap<string, string>,
  mappings: readonly SourceMapping[],
): string {
  // A module map must not embed every source in the project. Bundle maps naturally pick
  // up all sources referenced by their mappings; per-type maps stay proportional to the
  // type they describe.
  const sources = [...new Set(mappings.map((mapping) => mapping.source))].sort();
  const sourceIndex = new Map(sources.map((source, index) => [source, index]));
  const usable = [...mappings]
    .sort((a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn);
  const byLine = new Map<number, SourceMapping[]>();
  for (const mapping of usable) {
    const list = byLine.get(mapping.generatedLine) ?? [];
    list.push(mapping);
    byLine.set(mapping.generatedLine, list);
  }

  const maxLine = usable.reduce((max, mapping) => Math.max(max, mapping.generatedLine), 0);
  const lines: string[] = [];
  let previousSource = 0;
  let previousLine = 0;
  let previousColumn = 0;
  for (let line = 1; line <= maxLine; line += 1) {
    const entries = byLine.get(line) ?? [];
    let previousGeneratedColumn = 0;
    lines.push(entries.map((mapping) => {
      const source = sourceIndex.get(mapping.source)!;
      const segment = [
        mapping.generatedColumn - previousGeneratedColumn,
        source - previousSource,
        mapping.line - 1 - previousLine,
        mapping.column - previousColumn,
      ].map(encodeVlq).join("");
      previousGeneratedColumn = mapping.generatedColumn;
      previousSource = source;
      previousLine = mapping.line - 1;
      previousColumn = mapping.column;
      return segment;
    }).join(","));
  }

  return JSON.stringify({
    version: 3,
    file,
    sources,
    sourcesContent: sources.map((source) => sourcesContent.get(source) ?? ""),
    names: [],
    mappings: lines.join(";"),
  });
}

export function spanMapping(span: Span, generatedLine: number): SourceMapping {
  return {
    generatedLine,
    generatedColumn: 0,
    source: span.file,
    line: span.line,
    column: Math.max(0, span.column - 1),
  };
}
