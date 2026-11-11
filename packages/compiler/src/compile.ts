import type { SourceUnit } from "./semantic/analyzer.ts";
import { analyzeProject } from "./semantic/analyzer.ts";
import type { ProjectGraph } from "./semantic/types.ts";
import { parseSource } from "./parser/parser.ts";
import { diag, hasErrors, type Diagnostic, type Span } from "./diagnostics.ts";
import { lowerProject } from "./ir/lower.ts";
import type { IRProgram } from "./ir/types.ts";
import { emitProject, type EmitOptions } from "./backend/js.ts";
import { bundleModules } from "./backend/bundle.ts";
import { createSourceMap } from "./backend/sourcemap.ts";

export interface CompileOptions extends EmitOptions {
  /** Emit one bundle module instead of one module per type. */
  bundle?: boolean;
  /** Bundle filename when `bundle` is true (default `app.js`). */
  bundleName?: string;
  /** Document/entry class FQCN; inferred when omitted. */
  entry?: string;
  /**
   * Authored stage size, the compiled equivalent of the SWF header. `flash.display.Stage` reports it
   * for every scale mode except NO_SCALE, so switching to NO_SCALE is a real resize.
   */
  stageWidth?: number;
  stageHeight?: number;
  /** Manifest filename (default `manifest.json`). */
  manifestName?: string;
}

export interface ManifestClass {
  name: string;
  base: string | null;
  interfaces: string[];
  file: string;
  entry: boolean;
}

export interface ProjectManifest {
  format: "as3js-manifest";
  version: 1;
  abi: 1;
  runtime: string;
  entry: string | null;
  /** Authored stage size; `null` when the project declares none and the first viewport is used. */
  stage: { width: number; height: number } | null;
  bundle: string | null;
  sourceMaps: boolean;
  classes: ManifestClass[];
  interfaces: Array<{ name: string; extends: string[]; file: string }>;
  sources: string[];
}

export interface CompileResult {
  graph: ProjectGraph;
  ir: IRProgram;
  files: Map<string, string>;
  diagnostics: Diagnostic[];
  manifest: ProjectManifest;
}

function moduleFileName(fqcn: string): string {
  return `${fqcn.replaceAll(".", "_")}.mjs`;
}

/** The authored movie size, or `null` when the caller declared none. */
function authoredStage(options: CompileOptions): { width: number; height: number } | null {
  const width = Number(options.stageWidth);
  const height = Number(options.stageHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

function chooseEntry(program: IRProgram, requested: string | undefined): string | null {
  if (requested) return program.classes.some((item) => item.fqcn === requested) ? requested : null;
  const sourceDepth = (item: IRProgram["classes"][number]): number =>
    item.span ? item.span.file.split(/[\\/]/).length : Number.MAX_SAFE_INTEGER;
  const displayRank = (item: IRProgram["classes"][number]): number => {
    if (item.base === "flash.display.MovieClip") return 0;
    if (item.base === "flash.display.Sprite") return 1;
    if (item.base?.startsWith("flash.display.")) return 2;
    return 3;
  };
  const callable = program.classes
    .filter((item) => item.ctor.params.every((param) => param.optional || param.rest))
    .sort((a, b) =>
      sourceDepth(a) - sourceDepth(b) ||
      displayRank(a) - displayRank(b) ||
      a.fqcn.localeCompare(b.fqcn),
    );
  return callable[0]?.fqcn ?? program.classes[0]?.fqcn ?? null;
}

function fallbackSpan(program: IRProgram): Span {
  return program.classes[0]?.span ?? program.interfaces[0]?.span ?? {
    file: "<manifest>",
    start: 0,
    end: 0,
    line: 1,
    column: 1,
  };
}

export function compileProject(
  units: readonly SourceUnit[],
  options: CompileOptions = {},
): CompileResult {
  const semantic = analyzeProject(units);
  const lower = lowerProject(units, semantic.graph);
  const diagnostics = [...semantic.diagnostics, ...lower.diagnostics];
  const emptyManifest: ProjectManifest = {
    format: "as3js-manifest",
    version: 1,
    abi: 1,
    runtime: options.runtimeSpecifier ?? "@as3js/runtime",
    entry: null,
    stage: null,
    bundle: null,
    sourceMaps: options.sourceMaps !== false,
    classes: [],
    interfaces: [],
    sources: [],
  };
  if (hasErrors(diagnostics)) {
    return {
      graph: semantic.graph,
      ir: lower.program,
      files: new Map(),
      diagnostics,
      manifest: emptyManifest,
    };
  }

  const sources = new Map(options.sources ?? []);
  const emitted = emitProject(lower.program, { ...options, sources });
  const files = new Map(emitted.files);
  if (options.sourceMaps !== false) {
    for (const [name, map] of emitted.maps) files.set(name, map);
  }

  const bundleName = options.bundleName ?? "app.js";
  if (options.bundle) {
    const bundled = bundleModules(emitted.files, options.runtimeSpecifier ?? "@as3js/runtime", emitted.mappings);
    let text = bundled.text;
    files.clear();
    files.set(bundleName, text);
    if (options.sourceMaps !== false) {
      const mapName = `${bundleName}.map`;
      files.set(mapName, createSourceMap(bundleName, sources, bundled.mappings));
      text += `//# sourceMappingURL=${mapName}\n`;
      files.set(bundleName, text);
    }
  }

  const entry = chooseEntry(lower.program, options.entry);
  if (options.entry && !entry) {
    diagnostics.push(diag(
      "error",
      "BLD001",
      `Entry class '${options.entry}' was not found in the compiled project`,
      fallbackSpan(lower.program),
    ));
  }
  const manifest: ProjectManifest = {
    format: "as3js-manifest",
    version: 1,
    abi: 1,
    runtime: options.runtimeSpecifier ?? "@as3js/runtime",
    entry,
    stage: authoredStage(options),
    bundle: options.bundle ? bundleName : null,
    sourceMaps: options.sourceMaps !== false,
    classes: lower.program.classes
      .map((item) => ({
        name: item.fqcn,
        base: item.base,
        interfaces: item.interfaces,
        file: options.bundle ? bundleName : moduleFileName(item.fqcn),
        entry: item.fqcn === entry,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    interfaces: lower.program.interfaces
      .map((item) => ({
        name: item.fqcn,
        extends: item.extends,
        file: options.bundle ? bundleName : moduleFileName(item.fqcn),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    sources: units.map((unit) => unit.file).sort(),
  };
  files.set(
    options.manifestName ?? "manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    graph: semantic.graph,
    ir: lower.program,
    files,
    diagnostics,
    manifest,
  };
}

export function compileSource(
  source: string,
  file = "input.as",
  options: CompileOptions = {},
): CompileResult {
  const parsed = parseSource(source, file);
  return compileProject(
    [{ file, program: parsed.program, diagnostics: parsed.diagnostics }],
    { ...options, sources: new Map([[file, source]]) },
  );
}
