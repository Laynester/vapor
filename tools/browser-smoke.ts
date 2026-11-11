import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileSource } from "../packages/compiler/src/compile.ts";
import { createPopFromDirectory } from "../packages/compiler/src/assets/pop.ts";

const root = process.cwd();
const output = join(root, "build/browser");

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

execFileSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.browser.json")],
  { stdio: "inherit", cwd: root },
);

const fixture = readFileSync(join(root, "tests/fixtures/Boot.as"), "utf8");
const result = compileSource(fixture, "Boot.as", {
  runtimeSpecifier: "./runtime/runtime/src/index.js",
  bundle: true,
});
if (result.diagnostics.length > 0) {
  for (const diagnostic of result.diagnostics) {
    console.error(`${diagnostic.code}: ${diagnostic.message}`);
  }
  process.exit(1);
}
for (const [file, source] of result.files) {
  writeFileSync(join(output, file), source);
}
const archive = createPopFromDirectory(join(root, "tests/fixtures/assets"), {
  bundle: "app",
  compression: "auto",
});
writeFileSync(join(output, "app.pop"), archive.bytes);

writeFileSync(
  join(output, "index.html"),
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>as3-js browser boot smoke</title></head>
<body>
<canvas id="canvas" width="120" height="80"></canvas>
<pre id="result">pending</pre>
<script type="module">
import { Boot } from "./app.js";
import { $flushEmbeddedAssets, $renderDisplay, $setAssetManager, AssetManager, PopArchive } from "./runtime/runtime/src/index.js";
try {
  const manager = new AssetManager();
  manager.addBundle("app", await PopArchive.load("./app.pop"));
  $setAssetManager(manager);
  const app = new Boot();
  app.build();
  await $flushEmbeddedAssets();
  const canvas = document.getElementById("canvas");
  const context = canvas.getContext("2d");
  $renderDisplay(app.root, context);
  const bitmapPixel = context.getImageData(60, 20, 1, 1).data;
  const manifest = manager.get("manifest.xml");
  const logical = manager.getText("logo");
  const value = app.run() +
    "|pixel:" + Array.from(bitmapPixel).join(",") +
    "|manifest:" + (manifest ? manifest.length : 0) +
    "|logical:" + (logical === "logo" ? "ok" : "missing") +
    "|compressed:" + manager.archive("app").manifest.assets.map((asset) => asset.compression).join(",");
  document.getElementById("result").textContent = value;
  document.documentElement.dataset.result = value;
} catch (error) {
  const message = "error: " + (error && error.stack ? error.stack : error);
  document.getElementById("result").textContent = message;
  document.documentElement.dataset.result = "error";
}
</script>
</body>
</html>
`,
);

console.log(`browser build: ${output}`);
