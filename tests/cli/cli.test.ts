import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readPopArchive } from "../../packages/compiler/src/assets/pop.ts";

const cli = join(process.cwd(), "packages/cli/src/main.ts");

function runCompile(source: string, out: string, extra: string[] = []): string {
  return execFileSync(process.execPath, [cli, "compile", source, out, ...extra], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });
}

function createProject(directory: string): { source: string } {
  const source = join(directory, "src");
  mkdirSync(join(source, "images"), { recursive: true });
  writeFileSync(
    join(source, "Hello.as"),
    readFileSync(new URL("../fixtures/Hello.as", import.meta.url), "utf8"),
  );
  writeFileSync(join(source, "images", "note.txt"), "compiled asset");
  writeFileSync(join(source, "images", ".DS_Store"), "not an asset");
  return { source };
}

test("compile emits a minified JS bundle, runtime, map, manifest and app.pop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "as3js-cli-"));
  const { source } = createProject(directory);
  const out = join(directory, "out");
  const host = join(directory, "host.js");
  writeFileSync(host, 'window.__as3jsFlashVars = { "client.starting": "Loading" };\n');
  try {
    const stdout = runCompile(source, out, ["--browser", "--host", host]);
    assert.match(stdout, /bundle: .*app\.js .*minified/);
    assert.match(stdout, /browser: .*index\.html/);
    for (const file of ["app.js", "app.js.map", "runtime.js", "runtime.js.map", "manifest.json", "app.pop", "boot.js", "host.js", "index.html"]) {
      assert.equal(existsSync(join(out, file)), true, `${file} should be emitted`);
    }
    assert.match(readFileSync(join(out, "index.html"), "utf8"), /<script src="\.\/host\.js"><\/script>/);
    assert.match(readFileSync(join(out, "host.js"), "utf8"), /client\.starting/);
    assert.doesNotMatch(readFileSync(join(out, "boot.js"), "utf8"), /Hello/);
    assert.match(readFileSync(join(out, "boot.js"), "utf8"), /manifest\.json/);

    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as any;
    assert.equal(manifest.runtime, "./runtime.js");
    assert.equal(manifest.bundle, "app.js");
    assert.equal(manifest.sourceMaps, true);

    const bundle = readFileSync(join(out, "app.js"), "utf8");
    assert.match(bundle, /import\{/);
    // A minified bundle is a couple of long lines, not one statement per line.
    assert.ok(bundle.split("\n").filter((line) => line.trim() !== "").length <= 3);
    assert.doesNotMatch(bundle, /\.ts["']/);
    assert.match(bundle, /sourceMappingURL=app\.js\.map/);

    const map = JSON.parse(readFileSync(join(out, "app.js.map"), "utf8")) as any;
    assert.equal(map.version, 3);
    assert.ok(map.sources.some((file: string) => file.endsWith("Hello.as")));
    assert.ok(map.sourcesContent.some((content: string) => content.includes("class Hello")));

    const archive = readPopArchive(readFileSync(join(out, "app.pop")));
    assert.equal(archive.manifest.assets.length, 1);
    assert.equal(archive.manifest.assets[0]?.name, "images/note.txt");
    assert.deepEqual(archive.manifest.assets[0]?.aliases, ["note.txt"]);
    assert.equal(archive.manifest.assets.some((asset) => asset.name.endsWith(".as")), false);
    assert.equal(archive.manifest.assets.some((asset) => asset.name.includes(".DS_Store")), false);

    writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
    const exported = await import(`${pathToFileURL(join(out, "app.js")).href}?cli-test=${Date.now()}`);
    assert.equal(typeof exported.Hello, "function");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compile merges extra assets and ignores a prior compiler output directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "as3js-cli-extra-"));
  const { source } = createProject(directory);
  const extra = join(directory, "extra");
  mkdirSync(extra);
  writeFileSync(join(extra, "extra.bin"), new Uint8Array([1, 2, 3]));
  const out = join(directory, "out");
  const second = join(directory, "out2");
  try {
    runCompile(source, out, [extra]);
    const merged = readPopArchive(readFileSync(join(out, "app.pop")));
    assert.deepEqual(merged.manifest.assets.map((asset) => asset.name).sort(), [
      "extra.bin",
      "images/note.txt",
    ]);

    runCompile(source, second, [out]);
    const ignored = readPopArchive(readFileSync(join(second, "app.pop")));
    assert.deepEqual(ignored.manifest.assets.map((asset) => asset.name), ["images/note.txt"]);
    assert.equal(ignored.manifest.assets.some((asset) => asset.name.endsWith("app.js")), false);

    const nested = join(source, "generated");
    runCompile(source, nested);
    const nestedArchive = readPopArchive(readFileSync(join(nested, "app.pop")));
    assert.deepEqual(nestedArchive.manifest.assets.map((asset) => asset.name), ["images/note.txt"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compile --lazy-assets splits archives into dependent bundles", () => {
  const directory = mkdtempSync(join(tmpdir(), "as3js-cli-lazy-"));
  const { source } = createProject(directory);
  writeFileSync(join(source, "images", "second.txt"), "another compiled asset");
  const out = join(directory, "out");
  try {
    const stdout = runCompile(source, out, ["--lazy-assets", "1"]);
    assert.match(stdout, /asset bundles: 2/);
    assert.equal(existsSync(join(out, "app.pop")), true);
    assert.equal(existsSync(join(out, "app-2.pop")), true);
    const first = readPopArchive(readFileSync(join(out, "app.pop")));
    const second = readPopArchive(readFileSync(join(out, "app-2.pop")));
    assert.equal(first.manifest.assets.length, 1);
    assert.equal(second.manifest.assets.length, 1);
    assert.deepEqual(second.manifest.dependencies, ["app"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compile --no-source-maps minifies without writing source maps", () => {
  const directory = mkdtempSync(join(tmpdir(), "as3js-cli-nomap-"));
  const { source } = createProject(directory);
  const out = join(directory, "out");
  try {
    const stdout = runCompile(source, out, ["--no-source-maps"]);
    assert.match(stdout, /minified/);
    assert.equal(existsSync(join(out, "app.js.map")), false);
    assert.equal(existsSync(join(out, "runtime.js.map")), false);
    assert.doesNotMatch(readFileSync(join(out, "app.js"), "utf8"), /sourceMappingURL/);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as any;
    assert.equal(manifest.sourceMaps, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
