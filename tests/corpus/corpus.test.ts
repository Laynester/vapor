import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSource } from "../../packages/compiler/src/parser/parser.ts";
import {
  analyzeProject,
  type SourceUnit,
} from "../../packages/compiler/src/semantic/analyzer.ts";

/**
 * Representative snapshots over a real AS3 corpus. The corpus is not part of this
 * repository: point AS3_CORPUS_ROOT at any AS3 `src` tree, or the tests are skipped.
 */
const CORPUS_ROOT = process.env.AS3_CORPUS_ROOT ??
  "/Users/laynester/Projects/habbo/HabboSwfOpenSource/src";

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".as")) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

const files = existsSync(CORPUS_ROOT) ? collectSourceFiles(CORPUS_ROOT) : [];
const skip = files.length === 0
  ? `AS3 corpus not found at ${CORPUS_ROOT}; set AS3_CORPUS_ROOT to run these snapshots`
  : false;

function representativeSample(all: string[], count: number): string[] {
  const sizes = new Map(all.map((file) => [file, statSync(file).size]));
  const largestCount = Math.ceil(count / 2);
  const largest = [...all]
    .sort((a, b) => (sizes.get(b)! - sizes.get(a)!) || a.localeCompare(b))
    .slice(0, largestCount);
  const spreadCount = count - largestCount;
  const spread: string[] = [];
  for (let index = 0; index < spreadCount; index += 1) {
    spread.push(all[Math.floor(((index + 0.5) * all.length) / spreadCount)]!);
  }
  return [...new Set([...largest, ...spread])].sort();
}

function parseFile(file: string): SourceUnit {
  const parsed = parseSource(readFileSync(file, "utf8"), file);
  return { file, program: parsed.program, diagnostics: parsed.diagnostics ?? [] };
}

test("parses representative real corpus files without errors", { skip }, () => {
  const sample = representativeSample(files, 16);
  assert.ok(sample.length >= 12);
  for (const file of sample) {
    const parsed = parseFile(file);
    const errors = (parsed.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === "error");
    assert.deepEqual(errors, [], file);
  }
});

test("analyzes the whole corpus without errors", { skip }, () => {
  const units = files.map((file) => parseFile(file));
  const result = analyzeProject(units);
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");

  // Snapshot of the measured corpus (2026-11-09); update deliberately with the corpus.
  assert.equal(units.length, 7160);
  assert.equal(result.graph.types.length, 7163);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 18);
  assert.equal(result.graph.classInit.cycles.length, 13);
  // Every non-dynamic external member the corpus touches is declared. Dynamic types
  // (Dictionary, URLVariables) are excluded by design, not by omission.
  assert.deepEqual(result.memberAudit, []);
});
