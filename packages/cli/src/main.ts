import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { minify_sync } from "terser";
import { parseSource } from "../../compiler/src/parser/parser.ts";
import { formatDiagnostic, hasErrors } from "../../compiler/src/diagnostics.ts";
import { toSnapshot } from "../../compiler/src/ast.ts";
import { compileProject, compileSource } from "../../compiler/src/compile.ts";
import { buildPop, buildPopSet, createPopFromDirectory, type PopCompression, type PopInputFile } from "../../compiler/src/assets/pop.ts";
import { browserBoot, browserIndex } from "../../compiler/src/backend/boot.ts";
import {
  analyzeProject,
  type SourceUnit,
} from "../../compiler/src/semantic/analyzer.ts";

function usage(): never {
  console.error(`Usage:
  as3js parse-file <file.as>
  as3js parse-corpus <directory> [--verbose]
  as3js analyze-file <file.as> [--graph]
  as3js analyze-corpus <directory> [--verbose] [--strict] [--graph <path>] [--member-audit <path>]
  as3js compile <directory> <outDir> [extraAssetsDir] [--runtime <specifier>] [--entry <fqcn>]
      [--browser] [--host <script>] [--stage-size <WxH>] [--no-minify] [--terser] [--no-source-maps] [--no-compress] [--lazy-assets <count>] [--diagnostics <path>]
  as3js compile-file <file.as> <outDir> [--runtime <specifier>] [--modules] [--assets <dir>] [--entry <fqcn>] [--stage-size <WxH>] [--no-source-maps] [--no-compress]
  as3js compile-project <directory> <outDir> [--runtime <specifier>] [--modules] [--assets <dir>] [--entry <fqcn>] [--stage-size <WxH>] [--no-source-maps] [--no-compress] [--diagnostics <path>]`);
  process.exit(2);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, out);
    } else if (entry.isFile() && entry.name.endsWith(".as")) {
      out.push(path);
    }
  }
  return out;
}

function sortedWalk(dir: string): string[] {
  return walk(dir).sort();
}

function collectAssetInputs(directory: string, exclude?: string): PopInputFile[] {
  const files: string[] = [];
  const excluded = exclude ? resolve(exclude) : null;
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (excluded === null || resolve(full) !== excluded) visit(full);
      } else if (entry.isFile() && !entry.name.endsWith(".as")) files.push(full);
    }
  };
  visit(directory);
  return files.map((file) => ({
    source: relative(directory, file).split(sep).join("/"),
    data: readFileSync(file),
  }));
}

/** A directory emitted by this compiler is not an asset input directory. */
function isCompilerOutput(directory: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as { format?: unknown };
    return manifest.format === "as3js-manifest";
  } catch {
    return false;
  }
}

function readUnit(file: string): SourceUnit {
  const source = readFileSync(file, "utf8");
  const parsed = parseSource(source, file);
  return { file, program: parsed.program, diagnostics: parsed.diagnostics };
}

function printDiagnostics(source: string, diagnostics: readonly import("../../compiler/src/diagnostics.ts").Diagnostic[]): void {
  for (const diagnostic of diagnostics) console.error(formatDiagnostic(diagnostic));
  if (diagnostics.length > 0) console.error(`(${source}: ${diagnostics.length} diagnostic(s))`);
}

function summary(diagnostics: readonly import("../../compiler/src/diagnostics.ts").Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  return `errors: ${errors}\nwarnings: ${warnings}`;
}

const RUNTIME_ENTRY = fileURLToPath(new URL("../../runtime/src/index.ts", import.meta.url));

function buildRuntimeFiles(minify: boolean, sourceMaps: boolean): Array<[string, string]> {
  const result = buildSync({
    entryPoints: [RUNTIME_ENTRY],
    outfile: "runtime.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    minify,
    keepNames: true,
    sourcemap: sourceMaps ? "external" : false,
    legalComments: "none",
    logLevel: "silent",
  });
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((error) => error.text).join("\n"));
  }
  return result.outputFiles.map((file) => [basename(file.path), file.text]);
}

function minifyBundleWithTerser(
  code: string,
  map: string | undefined,
  bundleName: string,
  sourceMaps: boolean,
): { code: string; map: string | undefined } {
  if (sourceMaps && !map) throw new Error(`Cannot minify ${bundleName}: its source map is missing`);
  const result = minify_sync(code, {
    module: true,
    ecma: 2022,
    compress: { passes: 2 },
    mangle: { keep_classnames: true, keep_fnames: true },
    format: { comments: false },
    sourceMap: sourceMaps && map ? { content: map, filename: bundleName, url: `${bundleName}.map` } : false,
  });
  if (!result.code) throw new Error(`Minifying ${bundleName} produced no output`);
  const outputMap = typeof result.map === "string" ? result.map : result.map ? JSON.stringify(result.map) : undefined;
  return {
    code: result.code.endsWith("\n") ? result.code : `${result.code}\n`,
    map: outputMap,
  };
}

/**
 * Minifies with esbuild's native (multi-threaded) minifier. The input bundle's source map is
 * handed over inline so esbuild composes it; the composed map is extracted again for the
 * `.map` file. On the current corpus this is ~13x faster than Terser and slightly smaller.
 */
function minifyBundle(
  code: string,
  map: string | undefined,
  bundleName: string,
  sourceMaps: boolean,
): { code: string; map: string | undefined } {
  if (sourceMaps && !map) throw new Error(`Cannot minify ${bundleName}: its source map is missing`);
  const bare = code.replace(/\n?\/\/# sourceMappingURL=.*\n?$/, "\n");
  const input =
    sourceMaps && map
      ? `${bare}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map, "utf8").toString("base64")}\n`
      : bare;
  const result = buildSync({
    stdin: { contents: input, sourcefile: bundleName, loader: "js" },
    bundle: false,
    write: false,
    minify: true,
    keepNames: true,
    sourcemap: sourceMaps ? "inline" : false,
    format: "esm",
    target: "es2022",
    legalComments: "none",
    logLevel: "silent",
  });
  if (result.errors.length > 0) {
    throw new Error(`Cannot minify ${bundleName}: ${result.errors.map((error) => error.text).join("; ")}`);
  }
  let text = result.outputFiles[0]?.text;
  if (!text) throw new Error(`Minifying ${bundleName} produced no output`);
  let outputMap: string | undefined;
  if (sourceMaps) {
    const match = /sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/.exec(text);
    if (!match) throw new Error(`Cannot minify ${bundleName}: esbuild returned no inline source map`);
    outputMap = Buffer.from(match[1]!, "base64").toString("utf8");
  }
  text = text.replace(/\n?\/\/# sourceMappingURL=.*\n?$/, "\n");
  if (sourceMaps) text += `//# sourceMappingURL=${bundleName}.map\n`;
  return {
    code: text.endsWith("\n") ? text : `${text}\n`,
    map: outputMap,
  };
}

function parseUnits(files: readonly string[]): { units: SourceUnit[]; sources: Map<string, string> } {
  const units: SourceUnit[] = [];
  const sources = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const parsed = parseSource(source, file);
    units.push({ file, program: parsed.program, diagnostics: parsed.diagnostics });
    sources.set(file, source);
  }
  return { units, sources };
}

async function main(): Promise<void> {
  const [command, target, ...rest] = process.argv.slice(2);
  if (!command || !target) usage();

  if (command === "parse-file") {
    const source = readFileSync(target, "utf8");
    const result = parseSource(source, target);
    if (result.diagnostics.length > 0) {
      for (const diagnostic of result.diagnostics) console.error(formatDiagnostic(diagnostic));
      process.exit(1);
    }
    console.log(JSON.stringify(toSnapshot(result.program), null, 2));
    return;
  }

  if (command === "compile") {
    const positional: string[] = [];
    let runtimeSpecifier: string | undefined;
    let assetsDir: string | null = null;
    let entry: string | undefined;
    let diagnosticsPath: string | null = null;
    let minify = true;
    let sourceMaps = true;
    let compression: PopCompression = "auto";
    let lazyAssets = 0;
    let stageWidth: number | undefined;
    let stageHeight: number | undefined;
    let browser = false;
    let hostPath: string | null = null;
    let terserMinify = false;
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (arg === "--runtime" || arg === "--assets" || arg === "--entry" || arg === "--diagnostics") {
        const value = rest[index + 1];
        if (!value) usage();
        if (arg === "--runtime") runtimeSpecifier = value;
        else if (arg === "--assets") assetsDir = value;
        else if (arg === "--entry") entry = value;
        else diagnosticsPath = value;
        index += 1;
        continue;
      }
      if (arg === "--stage-size") {
        const value = rest[index + 1];
        const match = value ? /^(\d+)x(\d+)$/.exec(value) : null;
        if (!match) usage();
        stageWidth = Number(match[1]);
        stageHeight = Number(match[2]);
        index += 1;
        continue;
      }
      if (arg === "--browser") {
        browser = true;
        continue;
      }
      if (arg === "--host") {
        const value = rest[index + 1];
        if (!value) usage();
        hostPath = value;
        index += 1;
        continue;
      }
      if (arg === "--no-minify") {
        minify = false;
        continue;
      }
      if (arg === "--terser") {
        terserMinify = true;
        continue;
      }
      if (arg === "--no-source-maps") {
        sourceMaps = false;
        continue;
      }
      if (arg === "--no-compress") {
        compression = "store";
        continue;
      }
      if (arg === "--lazy-assets") {
        const value = rest[index + 1];
        if (!value) usage();
        lazyAssets = Math.max(1, Number(value) || 1);
        index += 1;
        continue;
      }
      if (arg.startsWith("--")) continue;
      positional.push(arg);
    }
    const outDir = positional[0];
    if (!outDir || positional.length > 2) usage();
    if (!assetsDir && positional[1]) assetsDir = positional[1];

    let files: string[];
    try {
      files = sortedWalk(statSync(target).isDirectory() ? target : usage());
    } catch (error) {
      console.error(`Cannot read project at ${target}: ${(error as Error).message}`);
      process.exit(2);
    }
    const { units, sources } = parseUnits(files);
    const emitRuntime = !runtimeSpecifier;
    const result = compileProject(units, {
      runtimeSpecifier: runtimeSpecifier ?? "./runtime.js",
      ...(entry ? { entry } : {}),
      sources,
      bundle: true,
      sourceMaps,
      ...(stageWidth && stageHeight ? { stageWidth, stageHeight } : {}),
    });
    const errors = result.diagnostics.filter((item) => item.severity === "error").length;
    const warnings = result.diagnostics.length - errors;
    for (const diagnostic of result.diagnostics.filter((item) => item.severity === "error").slice(0, 20)) {
      console.error(formatDiagnostic(diagnostic));
    }
    console.log(`errors: ${errors}`);
    console.log(`warnings: ${warnings}`);
    if (diagnosticsPath) {
      mkdirSync(dirname(diagnosticsPath), { recursive: true });
      writeFileSync(diagnosticsPath, `${JSON.stringify(result.diagnostics, null, 2)}\n`);
      console.log(`diagnostics: ${diagnosticsPath}`);
    }
    if (hasErrors(result.diagnostics) || result.files.size === 0) {
      process.exitCode = 1;
      return;
    }
    if (hostPath && !browser) {
      console.error("Cannot use --host without --browser");
      process.exitCode = 1;
      return;
    }
    if (browser && !result.manifest.entry) {
      console.error("Cannot emit a browser launcher: the project has no entry class");
      process.exitCode = 1;
      return;
    }

    const bundleName = result.manifest.bundle ?? "app.js";
    let bundleCode = result.files.get(bundleName);
    let bundleMap = result.files.get(`${bundleName}.map`);
    if (!bundleCode) throw new Error(`Compiler did not emit ${bundleName}`);
    if (minify) {
      const minified = terserMinify
        ? minifyBundleWithTerser(bundleCode, bundleMap, bundleName, sourceMaps)
        : minifyBundle(bundleCode, bundleMap, bundleName, sourceMaps);
      bundleCode = minified.code;
      bundleMap = minified.map;
      result.files.set(bundleName, bundleCode);
      if (bundleMap) result.files.set(`${bundleName}.map`, bundleMap);
      else result.files.delete(`${bundleName}.map`);
    }

    let runtimeFiles: Array<[string, string]> = [];
    if (emitRuntime) {
      try {
        runtimeFiles = buildRuntimeFiles(minify, sourceMaps);
      } catch (error) {
        console.error(`Cannot build runtime: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
    }

    mkdirSync(outDir, { recursive: true });
    for (const [file, content] of result.files) writeFileSync(join(outDir, file), content);
    for (const [file, content] of runtimeFiles) writeFileSync(join(outDir, file), content);
    if (browser) {
      if (hostPath) writeFileSync(join(outDir, "host.js"), readFileSync(hostPath));
      writeFileSync(join(outDir, "boot.js"), browserBoot({ bundle: bundleName }));
      writeFileSync(join(outDir, "index.html"), browserIndex(hostPath ? { host: "host.js" } : {}));
    }

    let archive;
    try {
      const assetInputs = collectAssetInputs(target, outDir);
      if (assetsDir && resolve(assetsDir) !== resolve(target)) {
        if (isCompilerOutput(assetsDir)) {
          console.warn(`Ignoring generated output directory ${assetsDir}; pass a real asset directory instead.`);
        } else {
          assetInputs.push(...collectAssetInputs(assetsDir));
        }
      }
      const set = lazyAssets > 0
        ? buildPopSet(assetInputs, {
          baseBundle: "app",
          maxAssetsPerBundle: lazyAssets,
          compression,
        })
        : [buildPop(assetInputs, { bundle: "app", compression })];
      archive = set[0]!;
      for (const item of set) writeFileSync(join(outDir, `${item.manifest.bundle}.pop`), item.bytes);
      if (set.length > 1) {
        console.log(`asset bundles: ${set.length} (${set.map((item) => item.manifest.bundle).join(", ")})`);
      }
    } catch (error) {
      console.error(`Cannot pack assets from ${assetsDir ?? target}: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }

    console.log(`files: ${files.length}`);
    console.log(`types: ${result.manifest.classes.length + result.manifest.interfaces.length}`);
    console.log(`entry: ${result.manifest.entry ?? "(none)"}`);
    console.log(`bundle: ${join(outDir, bundleName)} (${(Buffer.byteLength(bundleCode) / 1024).toFixed(1)} KiB${minify ? ", minified" : ""})`);
    if (emitRuntime) console.log(`runtime: ${join(outDir, "runtime.js")}${sourceMaps ? " + map" : ""}`);
    else console.log(`runtime: ${runtimeSpecifier}`);
    console.log(`manifest: ${join(outDir, "manifest.json")}`);
    console.log(`assets: ${archive.manifest.assets.length} in ${join(outDir, "app.pop")}`);
    if (browser) console.log(`browser: ${join(outDir, "index.html")}`);
    console.log(`output: ${outDir}`);
    return;
  }

  if (command === "compile-project") {
    const positional: string[] = [];
    let runtimeSpecifier: string | undefined;
    let assetsDir: string | null = null;
    let entry: string | undefined;
    let diagnosticsPath: string | null = null;
    let stageWidth: number | undefined;
    let stageHeight: number | undefined;
    let verbose = false;
    let compression: PopCompression = "auto";
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (arg === "--runtime" || arg === "--assets" || arg === "--entry" || arg === "--diagnostics") {
        const value = rest[index + 1];
        if (!value) usage();
        if (arg === "--runtime") runtimeSpecifier = value;
        else if (arg === "--assets") assetsDir = value;
        else if (arg === "--entry") entry = value;
        else diagnosticsPath = value;
        index += 1;
        continue;
      }
      if (arg === "--stage-size") {
        const value = rest[index + 1];
        const match = value ? /^(\d+)x(\d+)$/.exec(value) : null;
        if (!match) usage();
        stageWidth = Number(match[1]);
        stageHeight = Number(match[2]);
        index += 1;
        continue;
      }
      if (arg === "--verbose") {
        verbose = true;
        continue;
      }
      if (arg === "--no-compress") {
        compression = "store";
        continue;
      }
      if (arg.startsWith("--")) continue;
      positional.push(arg);
    }
    const outDir = positional[0];
    if (!outDir) usage();
    let files: string[];
    try {
      files = sortedWalk(statSync(target).isDirectory() ? target : usage());
    } catch (error) {
      console.error(`Cannot read project at ${target}: ${(error as Error).message}`);
      process.exit(2);
    }
    const { units, sources } = parseUnits(files);
    const result = compileProject(units, {
      ...(runtimeSpecifier ? { runtimeSpecifier } : {}),
      ...(entry ? { entry } : {}),
      sources,
      bundle: !rest.includes("--modules"),
      sourceMaps: !rest.includes("--no-source-maps"),
      ...(stageWidth && stageHeight ? { stageWidth, stageHeight } : {}),
    });
    if (verbose) {
      printDiagnostics(target, result.diagnostics);
    } else {
      const byCode = new Map<string, number>();
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity === "error") {
          byCode.set(diagnostic.code, (byCode.get(diagnostic.code) ?? 0) + 1);
        }
      }
      for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
        console.log(`${code}: ${count} error(s)`);
      }
      for (const diagnostic of result.diagnostics.filter((item) => item.severity === "error").slice(0, 20)) {
        console.error(formatDiagnostic(diagnostic));
      }
      const errors = result.diagnostics.filter((item) => item.severity === "error").length;
      const warnings = result.diagnostics.length - errors;
      console.log(`errors: ${errors}`);
      console.log(`warnings: ${warnings}`);
    }
    if (diagnosticsPath) {
      mkdirSync(dirname(diagnosticsPath), { recursive: true });
      writeFileSync(diagnosticsPath, `${JSON.stringify(result.diagnostics, null, 2)}\n`);
      console.log(`diagnostics: ${diagnosticsPath}`);
    }
    if (hasErrors(result.diagnostics) || result.files.size === 0) {
      process.exitCode = 1;
      return;
    }
    mkdirSync(outDir, { recursive: true });
    for (const [file, content] of result.files) writeFileSync(join(outDir, file), content);
    console.log(`files: ${files.length}`);
    console.log(`types: ${result.manifest.classes.length + result.manifest.interfaces.length}`);
    console.log(`output files: ${result.files.size}`);
    if (result.manifest.bundle) console.log(`bundle: ${join(outDir, result.manifest.bundle)}`);
    console.log(`entry: ${result.manifest.entry ?? "(none)"}`);
    console.log(`manifest: ${join(outDir, "manifest.json")}`);
    if (assetsDir) {
      try {
        const archive = createPopFromDirectory(assetsDir, { bundle: "app", compression });
        writeFileSync(join(outDir, "app.pop"), archive.bytes);
        console.log(`assets: ${archive.manifest.assets.length} in ${join(outDir, "app.pop")}`);
      } catch (error) {
        console.error(`Cannot pack assets from ${assetsDir}: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
    }
    console.log(`output: ${outDir}`);
    return;
  }

  if (command === "compile-file") {
    const positional: string[] = [];
    let runtimeSpecifier: string | undefined;
    let assetsDir: string | null = null;
    let entry: string | undefined;
    let stageWidth: number | undefined;
    let stageHeight: number | undefined;
    let compression: PopCompression = "auto";
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (arg === "--runtime" || arg === "--assets" || arg === "--entry") {
        const value = rest[index + 1];
        if (!value) usage();
        if (arg === "--runtime") runtimeSpecifier = value;
        else if (arg === "--assets") assetsDir = value;
        else entry = value;
        index += 1;
        continue;
      }
      if (arg === "--stage-size") {
        const value = rest[index + 1];
        const match = value ? /^(\d+)x(\d+)$/.exec(value) : null;
        if (!match) usage();
        stageWidth = Number(match[1]);
        stageHeight = Number(match[2]);
        index += 1;
        continue;
      }
      if (arg === "--no-compress") {
        compression = "store";
        continue;
      }
      if (arg.startsWith("--")) continue;
      positional.push(arg);
    }
    const outDir = positional[0];
    if (!outDir) usage();
    const bundle = !rest.includes("--modules");
    const sourceMaps = !rest.includes("--no-source-maps");
    const source = readFileSync(target, "utf8");
    const result = compileSource(source, target, {
      ...(runtimeSpecifier ? { runtimeSpecifier } : {}),
      ...(entry ? { entry } : {}),
      bundle,
      sourceMaps,
      ...(stageWidth && stageHeight ? { stageWidth, stageHeight } : {}),
    });
    printDiagnostics(target, result.diagnostics);
    if (hasErrors(result.diagnostics) || result.files.size === 0) {
      process.exitCode = 1;
      return;
    }
    mkdirSync(outDir, { recursive: true });
    for (const [file, content] of result.files) writeFileSync(join(outDir, file), content);
    console.log(`files: ${result.files.size}`);
    if (bundle) console.log(`bundle: ${join(outDir, result.manifest.bundle ?? "app.js")}`);
    console.log(`entry: ${result.manifest.entry ?? "(none)"}`);
    console.log(`manifest: ${join(outDir, "manifest.json")}`);
    if (assetsDir) {
      try {
        const archive = createPopFromDirectory(assetsDir, { bundle: "app", compression });
        writeFileSync(join(outDir, "app.pop"), archive.bytes);
        console.log(`assets: ${archive.manifest.assets.length} in ${join(outDir, "app.pop")}`);
      } catch (error) {
        console.error(`Cannot pack assets from ${assetsDir}: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
    }
    console.log(`output: ${outDir}`);
    return;
  }

  if (command === "analyze-file") {
    const result = analyzeProject([readUnit(target)]);
    printDiagnostics(target, result.diagnostics);
    if (rest.includes("--graph")) console.log(JSON.stringify(result.graph, null, 2));
    else console.log(`file: ${target}\ntypes: ${result.graph.types.length}\n${summary(result.diagnostics)}`);
    process.exitCode = hasErrors(result.diagnostics) ? 1 : 0;
    return;
  }

  if (command === "parse-corpus") {
    let files: string[];
    try {
      files = sortedWalk(statSync(target).isDirectory() ? target : usage());
    } catch (error) {
      console.error(`Cannot read corpus at ${target}: ${(error as Error).message}`);
      process.exit(2);
    }

    const verbose = rest.includes("--verbose");
    const started = performance.now();
    let bytes = 0;
    let tokens = 0;
    let errors = 0;
    let warnings = 0;
    let filesWithErrors = 0;
    const samples: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      bytes += Buffer.byteLength(source);
      const result = parseSource(source, file);
      tokens += result.tokens.length - 1;
      const fileErrors = result.diagnostics.filter((d) => d.severity === "error");
      errors += fileErrors.length;
      warnings += result.diagnostics.length - fileErrors.length;
      if (fileErrors.length > 0) {
        filesWithErrors++;
        if (samples.length < 25) {
          samples.push(`${file} (${fileErrors.length} error${fileErrors.length === 1 ? "" : "s"})`);
          for (const diagnostic of fileErrors.slice(0, 3)) {
            samples.push(`  ${formatDiagnostic(diagnostic)}`);
          }
        }
        if (verbose) {
          for (const diagnostic of fileErrors) console.error(formatDiagnostic(diagnostic));
        }
      }
    }

    const elapsed = (performance.now() - started) / 1000;
    console.log(`files: ${files.length}`);
    console.log(`bytes: ${bytes}`);
    console.log(`tokens: ${tokens}`);
    console.log(`errors: ${errors} in ${filesWithErrors} file(s)`);
    console.log(`warnings: ${warnings}`);
    console.log(`elapsed: ${elapsed.toFixed(2)}s`);
    if (samples.length > 0) {
      console.log("\nsamples:");
      for (const sample of samples) console.log(sample);
    }
    process.exitCode = errors > 0 ? 1 : 0;
    return;
  }

  if (command !== "analyze-corpus") usage();

  let files: string[];
  try {
    files = sortedWalk(statSync(target).isDirectory() ? target : usage());
  } catch (error) {
    console.error(`Cannot read corpus at ${target}: ${(error as Error).message}`);
    process.exit(2);
  }

  const verbose = rest.includes("--verbose");
  const strict = rest.includes("--strict");
  const graphIndex = rest.indexOf("--graph");
  const graphPath = graphIndex >= 0 ? rest[graphIndex + 1] : null;
  if (graphIndex >= 0 && !graphPath) usage();
  const auditIndex = rest.indexOf("--member-audit");
  const auditPath = auditIndex >= 0 ? rest[auditIndex + 1] : null;
  if (auditIndex >= 0 && !auditPath) usage();

  const started = performance.now();
  const units: SourceUnit[] = [];
  let parseErrors = 0;
  for (const file of files) {
    const unit = readUnit(file);
    parseErrors += unit.diagnostics?.filter((d) => d.severity === "error").length ?? 0;
    units.push(unit);
  }

  const result = analyzeProject(units);
  const elapsed = (performance.now() - started) / 1000;
  if (verbose) for (const diagnostic of result.diagnostics) console.error(formatDiagnostic(diagnostic));

  const byCode = new Map<string, { errors: number; warnings: number }>();
  for (const diagnostic of result.diagnostics) {
    const entry = byCode.get(diagnostic.code) ?? { errors: 0, warnings: 0 };
    if (diagnostic.severity === "error") entry.errors++;
    else entry.warnings++;
    byCode.set(diagnostic.code, entry);
  }

  const errors = result.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = result.diagnostics.length - errors;
  const cycles = result.graph.classInit.cycles.length;
  console.log(`files: ${files.length}`);
  console.log(`types: ${result.graph.types.length}`);
  console.log(`parse errors: ${parseErrors}`);
  console.log(`semantic diagnostics: ${result.diagnostics.length}`);
  console.log(`errors: ${errors}`);
  console.log(`warnings: ${warnings}`);
  console.log(`class-init cycles: ${cycles}`);
  console.log(`elapsed: ${elapsed.toFixed(2)}s`);
  console.log("\nby code:");
  for (const [code, counts] of [...byCode.entries()].sort((a, b) => b[1].errors + b[1].warnings - (a[1].errors + a[1].warnings))) {
    console.log(`  ${code}: ${counts.errors} error(s), ${counts.warnings} warning(s)`);
  }
  if (graphPath) {
    writeFileSync(graphPath, `${JSON.stringify(result.graph, null, 2)}\n`);
    console.log(`graph: ${graphPath}`);
  }
  if (auditPath) {
    writeFileSync(auditPath, `${JSON.stringify(result.memberAudit, null, 2)}\n`);
    console.log(`member audit: ${auditPath}`);
    const totalUses = result.memberAudit.reduce((sum, entry) => sum + entry.count, 0);
    console.log(`unmodelled external members: ${result.memberAudit.length} distinct, ${totalUses} uses`);
    for (const entry of result.memberAudit.slice(0, 20)) {
      console.log(`  ${entry.count}x ${entry.fqcn}.${entry.member} (${entry.file}:${entry.line})`);
    }
  }
  process.exitCode = strict && errors > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
