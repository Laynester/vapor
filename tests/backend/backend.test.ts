import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateRawSync, deflateSync, inflateRawSync, inflateSync } from "node:zlib";
import { compileSource } from "../../packages/compiler/src/compile.ts";
import { buildPop, buildPopSet, createPopFromDirectory, readPopArchive } from "../../packages/compiler/src/assets/pop.ts";
import { browserBoot, browserIndex } from "../../packages/compiler/src/backend/boot.ts";
import {
  $getBaseUrl,
  $setAssetManager,
  getQualifiedClassName,
  $setBaseUrl,
  AssetManager,
  PopArchive,
} from "../../packages/runtime/src/index.ts";
import { parseSwf } from "../../packages/runtime/src/swf.ts";
import { decodePng } from "../../packages/runtime/src/png.ts";
import { startEchoServer } from "./websocket-server.ts";
import {
  $class,
  $createRoot,
  $dispatchMouseEvent,
  $runtimeClassNames,
  $error,
  $forIn,
  $int,
  $forEach,
  $is,
  $number,
  $renderDisplay,
  $runFrame,
  $runtimeClass,
  $string,
  $typeof,
  $uint,
  $runtimeValue,
  $setExternalVariables,
  $setExternalInterfaceBridge,
  $setLoaderProgress,
  $setStageMovieSize,
  $setStageSize,
  $setWebSocketFactory,
  $startFrameLoop,
  $stopFrameLoop,
  $vector,
  AS3RuntimeError,
} from "../../packages/runtime/src/index.ts";

test("lowers, emits, and executes classes with inheritance and accessors", async () => {
  const fixture = readFileSync(new URL("../fixtures/Backend.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Backend.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.files.has("demo_Base.mjs"));
  assert.ok(result.files.has("demo_Child.mjs"));
  assert.ok(result.files.has("demo_IGreeter.mjs"));
  assert.match(result.files.get("demo_Child.mjs")!, /import \{ Base \} from "\.\/demo_Base\.mjs"/);
  assert.match(result.files.get("demo_Base.mjs")!, /interfaces: \(\) => \[IGreeter\]/);
  assert.match(result.files.get("demo_Child.mjs")!, /\$super\(this, Base/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-backend-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }

    const baseModule = await import(pathToFileURL(join(directory, "demo_Base.mjs")).href);
    const childModule = await import(pathToFileURL(join(directory, "demo_Child.mjs")).href);
    const interfaceModule = await import(pathToFileURL(join(directory, "demo_IGreeter.mjs")).href);
    const Base = baseModule.Base;
    const Child = childModule.Child;
    const IGreeter = interfaceModule.IGreeter;

    assert.equal(Child.TAG, "child");
    const child = new Child(3);
    assert.ok(child instanceof Base);
    assert.equal(child.base, 4);
    assert.equal(child.extra, 4);
    assert.equal(child.unset, 0);
    assert.equal(child.describe(), "base:4:4");
    assert.equal(child.doubled, 9);
    assert.equal(child.greeting(), "base");
    assert.equal(child.isGreeter(), true);
    assert.equal(IGreeter.$fqcn, "demo.IGreeter");
    assert.deepEqual(child.makeVector(), [1, 2]);

    child.label = "changed";
    assert.equal(child.label, "changed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs static initializers before static member access", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      public class StaticInit {
        public static const VALUE:int = 2 + 3;
        public static const CODE:XML = <script>hello</script>;
        public static function code():String {
          return String(CODE);
        }
      }
      public class StaticUser {
        public static function read(type:Class):int {
          return type.VALUE;
        }
      }
      public class StaticCaller {
        public static function run():int {
          return StaticUser.read(StaticInit);
        }
      }
    }`,
    "StaticInit.as",
    { runtimeSpecifier },
  );
  assert.deepEqual(result.diagnostics, []);
  const generated = result.files.get("demo_StaticInit.mjs")!;
  assert.match(generated, /\$ensureInit\(/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-static-init-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { StaticInit } = await import(pathToFileURL(join(directory, "demo_StaticInit.mjs")).href);
    const { StaticCaller } = await import(pathToFileURL(join(directory, "demo_StaticCaller.mjs")).href);
    assert.equal(StaticCaller.run(), 5);
    assert.equal(StaticInit.VALUE, 5);
    assert.match(StaticInit.code(), /hello/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applies AS3 default parameter values when arguments are omitted", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      public class Defaults {
        public static function sum(a:int, b:int = 4):int {
          return a + b;
        }
        public function label(prefix:String = "x", count:int = 2):String {
          return prefix + count;
        }
        public function flag(value:Boolean = true):Boolean {
          return value;
        }
        public function nullable(value:String = null):String {
          return value;
        }
      }
    }`,
    "Defaults.as",
    { runtimeSpecifier },
  );
  assert.deepEqual(result.diagnostics, []);

  const directory = mkdtempSync(join(tmpdir(), "as3js-defaults-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Defaults } = await import(pathToFileURL(join(directory, "demo_Defaults.mjs")).href);
    assert.equal(Defaults.sum(1), 5);
    assert.equal(Defaults.sum(1, 2), 3);
    const defaults = new Defaults();
    assert.equal(defaults.label(), "x2");
    assert.equal(defaults.label("a"), "a2");
    assert.equal(defaults.label("a", 3), "a3");
    assert.equal(defaults.flag(), true);
    assert.equal(defaults.flag(false), false);
    assert.equal(defaults.nullable(), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("initializes uninitialized locals with AS3 type defaults", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      public class LocalDefaults {
        public function first(items:Array):Object {
          var index:uint;
          while (index < items.length) {
            return items[index];
          }
          return null;
        }
        public function countToThree():int {
          var total:int;
          for (var index:uint; index < 3; index++) {
            total++;
          }
          return total;
        }
        public function zero():int {
          var value:int;
          return value;
        }
        public function missing():Object {
          var value:Object;
          return value;
        }
        public function disabled():Boolean {
          var value:Boolean;
          return value;
        }
        public function untyped():* {
          var value:*;
          return value;
        }
      }
    }`,
    "LocalDefaults.as",
    { runtimeSpecifier },
  );
  assert.deepEqual(result.diagnostics, []);

  const directory = mkdtempSync(join(tmpdir(), "as3js-local-defaults-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { LocalDefaults } = await import(pathToFileURL(join(directory, "demo_LocalDefaults.mjs")).href);
    const defaults = new LocalDefaults();
    assert.equal(defaults.first(["a", "b"]), "a");
    assert.equal(defaults.countToThree(), 3);
    assert.equal(defaults.zero(), 0);
    assert.equal(defaults.missing(), null);
    assert.equal(defaults.disabled(), false);
    assert.equal(defaults.untyped(), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("calls inherited static methods through the declaring class", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      public class StaticBase {
        public static function read():String {
          return "base";
        }
      }
      public class StaticChild extends StaticBase {
        public function callInherited():String {
          return read();
        }
      }
    }`,
    "StaticInherited.as",
    { runtimeSpecifier },
  );
  assert.deepEqual(result.diagnostics, []);

  const directory = mkdtempSync(join(tmpdir(), "as3js-static-inherited-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { StaticChild } = await import(pathToFileURL(join(directory, "demo_StaticChild.mjs")).href);
    const child = new StaticChild();
    assert.equal(child.callInherited(), "base");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lowers class casts without constructing a new instance", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      import flash.events.MouseEvent;
      public class Casting {
        public function same(event:MouseEvent):MouseEvent {
          return MouseEvent(event);
        }
        public function arrayOf(value:Object):Array {
          return value as Array;
        }
        public function xmlOf(value:Object):XML {
          return value as XML;
        }
      }
    }`,
    "Casting.as",
    { runtimeSpecifier },
  );
  assert.deepEqual(result.diagnostics, []);
  const source = result.files.get("demo_Casting.mjs")!;
  assert.match(source, /\$cast\(event, \$runtimeClass\("flash\.events\.MouseEvent"\)\)/);
  assert.match(source, /\$cast\(value, "Array"\)/);
  assert.match(source, /\$cast\(value, \$runtimeClass\("XML"\)\)/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-cast-"));
  try {
    for (const [file, generated] of result.files) {
      writeFileSync(join(directory, file), generated);
    }
    const { Casting } = await import(pathToFileURL(join(directory, "demo_Casting.mjs")).href);
    const MouseEvent = $runtimeClass("flash.events.MouseEvent");
    const event = new MouseEvent(MouseEvent.MOUSE_MOVE);
    const casting = new Casting();
    assert.equal(casting.same(event), event);
    const array = [1, 2, 3];
    assert.equal(casting.arrayOf(array), array);
    assert.equal(casting.arrayOf("not an array"), null);
    const XML = $runtimeClass("XML");
    const xml = new XML("<root />");
    assert.equal(casting.xmlOf(xml), xml);
    assert.equal(casting.xmlOf("not xml"), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parenthesizes assignment and update expressions in larger expressions", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      public class Expressions {
        public function combine():int {
          var p:int = 0;
          var d:int = 0;
          d |= 1 >> (p += 2);
          return d;
        }
        public function read(object:Object):String {
          return object.value++.toString();
        }
      }
    }`,
    "Expressions.as",
    { runtimeSpecifier },
  );

  assert.deepEqual(result.diagnostics, []);
  const module = result.files.get("demo_Expressions.mjs")!;
  // Typed slots coerce on write, so compound assignment stays parenthesized inside the shift.
  assert.ok(
    module.includes(`(d = $coerce((d | (1 >> (p = $coerce((p + 2), "int")))), "int"));`),
    module,
  );
  assert.match(module, /\(object\.value\+\+\)\.toString\(\)/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-expressions-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Expressions } = await import(pathToFileURL(join(directory, "demo_Expressions.mjs")).href);
    const expressions = new Expressions();
    assert.equal(expressions.combine(), 0);
    assert.equal(expressions.read({ value: 3 }), "3");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds external interfaces and resolves them at runtime", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    "package demo { public class Shape implements flash.display.IBitmapDrawable {} }",
    "Shape.as",
    { runtimeSpecifier },
  );

  assert.deepEqual(result.diagnostics, []);
  assert.match(
    result.files.get("demo_Shape.mjs")!,
    /interfaces: \(\) => \[\$runtimeClass\("flash\.display\.IBitmapDrawable"\)\]/,
  );

  const directory = mkdtempSync(join(tmpdir(), "as3js-runtime-interface-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Shape } = await import(pathToFileURL(join(directory, "demo_Shape.mjs")).href);
    const IBitmapDrawable = $runtimeClass("flash.display.IBitmapDrawable");
    assert.ok($is(new Shape(), IBitmapDrawable));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("attaches a root stage before an entry constructor runs", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      import flash.display.MovieClip;
      public class Rooted extends MovieClip {
        public var sawStage:Boolean;
        public var mode:String;
        public function Rooted() {
          super();
          sawStage = stage != null;
          mode = root.loaderInfo.parameters["mode"];
        }
      }
    }`,
    "Rooted.as",
    { runtimeSpecifier },
  );

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-root-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Rooted } = await import(pathToFileURL(join(directory, "demo_Rooted.mjs")).href);
    $setExternalVariables({ mode: "test" });
    const rooted = $createRoot(Rooted);
    assert.equal(rooted.sawStage, true);
    assert.equal(rooted.mode, "test");
    assert.equal(rooted.root, rooted);
    assert.equal(rooted.stage.constructor.$fqcn, "flash.display.Stage");
    assert.equal(rooted.parent, rooted.stage);
    assert.equal($runtimeClass("flash.display.StageScaleMode").NO_SCALE, "noScale");
    assert.equal($runtimeClass("flash.display.StageQuality").LOW, "low");
    assert.equal($runtimeClass("flash.display.StageAlign").TOP_LEFT, "TL");
    assert.equal($runtimeClass("flash.events.HTTPStatusEvent").HTTP_STATUS, "httpStatus");
    assert.equal($runtimeClass("flash.events.SecurityErrorEvent").SECURITY_ERROR, "securityError");
    assert.equal($runtimeClass("flash.events.UncaughtErrorEvent").UNCAUGHT_ERROR, "uncaughtError");
    const ExternalInterface = $runtimeClass("flash.external.ExternalInterface");
    assert.equal(ExternalInterface.available, false);
    assert.throws(() => ExternalInterface.call("test"), AS3RuntimeError);
    $setExternalInterfaceBridge({ ping: (...args: any[]) => args.join(":") });
    assert.equal(ExternalInterface.available, true);
    assert.equal(ExternalInterface.call("ping", "a", 2), "a:2");
    assert.equal(ExternalInterface.call("missing.optional"), null);
    $setExternalInterfaceBridge(null);
    assert.equal(ExternalInterface.available, false);
    const Loader = $runtimeClass("flash.display.Loader");
    const LoaderInfo = $runtimeClass("flash.display.LoaderInfo");
    const URLRequest = $runtimeClass("flash.net.URLRequest");
    const loader = new Loader();
    assert.ok(loader.contentLoaderInfo instanceof LoaderInfo);
    loader.load(new URLRequest("library.swf"));
    assert.equal(loader.content, null);
    assert.equal(loader.contentLoaderInfo.bytesTotal, 0);
    const Capabilities = $runtimeClass("flash.system.Capabilities");
    assert.equal(typeof Capabilities.version, "string");
    assert.notEqual(Capabilities.playerType, "StandAlone");
    assert.ok(Capabilities.version.split(" ").length === 2);
    const ApplicationDomain = $runtimeClass("flash.system.ApplicationDomain");
    assert.ok(ApplicationDomain.currentDomain);
    const LoaderContext = $runtimeClass("flash.system.LoaderContext");
    const loaderContext = new LoaderContext(true);
    assert.equal(loaderContext.checkPolicyFile, true);
    assert.equal(loaderContext.applicationDomain, ApplicationDomain.currentDomain);
    const System = $runtimeClass("flash.system.System");
    assert.equal(typeof System.totalMemory, "number");
    assert.doesNotThrow(() => System.gc());
    assert.doesNotThrow(() => System.pauseForGCIfCollectionImminent(0.25));
    assert.doesNotThrow(() => System.disposeXML(null));
    assert.doesNotThrow(() => System.setClipboard("test"));
    const Security = $runtimeClass("flash.system.Security");
    assert.equal(Security.sandboxType, "remote");
    assert.doesNotThrow(() => Security.allowDomain("localhost"));
    assert.doesNotThrow(() => Security.loadPolicyFile("https://localhost/crossdomain.xml"));
    const TextFormat = $runtimeClass("flash.text.TextFormat");
    const TextFormatAlign = $runtimeClass("flash.text.TextFormatAlign");
    const TextField = $runtimeClass("flash.text.TextField");
    const format = new TextFormat("Ubuntu", 28, 0xffffff, true);
    format.align = TextFormatAlign.CENTER;
    const field = new TextField();
    field.defaultTextFormat = format;
    field.autoSize = "left";
    field.htmlText = "Loading";
    assert.equal(field.defaultTextFormat.font, "Ubuntu");
    assert.equal(field.defaultTextFormat.align, "center");
    assert.equal(field.text, "Loading");
    assert.ok(field.textWidth > 0);
    assert.ok(field.textHeight > 0);
    assert.ok(field.width > 0);
    // Flash fits characters to the pixel grid: textWidth is the sum of whole-pixel advances, so it is
    // an integer and a line measures exactly as its characters do one at a time.
    const perCharacter = new TextField();
    perCharacter.defaultTextFormat = new TextFormat("Ubuntu", 12, 0xffffff);
    perCharacter.text = "abc";
    const advances = ["a", "b", "c"].map((value) => {
      const single = new TextField();
      single.defaultTextFormat = perCharacter.defaultTextFormat;
      single.text = value;
      return single.textWidth;
    });
    assert.equal(perCharacter.textWidth, advances[0] + advances[1] + advances[2]);
    assert.equal(perCharacter.textWidth, Math.round(perCharacter.textWidth));
    // The autosize box is the text plus the player's two-pixel gutter on each side.
    perCharacter.autoSize = "left";
    assert.equal(perCharacter.width, perCharacter.textWidth + 4);
    assert.equal($runtimeClass("flash.text.TextFieldType").DYNAMIC, "dynamic");
    assert.equal($runtimeClass("flash.text.TextFieldAutoSize").LEFT, "left");
    assert.equal($runtimeClass("flash.text.AntiAliasType").ADVANCED, "advanced");
    const filter = new ($runtimeClass("flash.filters.DropShadowFilter"))();
    assert.equal(filter.blurX, 4);
    const MouseEvent = $runtimeClass("flash.events.MouseEvent");
    const mouse = new MouseEvent(MouseEvent.MOUSE_MOVE, true, false, 3, 4);
    assert.equal(mouse.type, "mouseMove");
    assert.equal(mouse.localX, 3);
    assert.equal(mouse.localY, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds external runtime base classes", async () => {
  const fixture = readFileSync(new URL("../fixtures/Hello.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Hello.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  assert.match(
    result.files.get("demo_Hello.mjs")!,
    /base: \(\) => \$runtimeClass\("flash\.display\.MovieClip"\)/,
  );

  const directory = mkdtempSync(join(tmpdir(), "as3js-runtime-base-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Hello } = await import(pathToFileURL(join(directory, "demo_Hello.mjs")).href);
    const MovieClip = $runtimeClass("flash.display.MovieClip");
    const hello = new Hello();
    assert.ok(hello instanceof MovieClip);
    assert.equal(hello.greet("Buffy"), "hello Buffy");
    assert.equal(hello.greet(null), "hello");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dispatches events and manages display-list children", async () => {
  const fixture = readFileSync(new URL("../fixtures/Display.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Display.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-display-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Display } = await import(pathToFileURL(join(directory, "demo_Display.mjs")).href);
    const Sprite = $runtimeClass("flash.display.Sprite");
    const IEventDispatcher = $runtimeClass("flash.events.IEventDispatcher");
    const display = new Display();
    assert.ok(display instanceof Sprite);
    assert.ok($is(display, IEventDispatcher));
    assert.equal(display.childCount(), 1);
    assert.equal(display.numChildren, 1);
    assert.equal(display.ping(), 1);
    assert.equal(display.ping(), 2);
    assert.equal(display.lastPhase, 2);
    display.removeChildAt(0);
    assert.equal(display.childCount(), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("initializes display children before base property assignment runs overrides", async () => {
  const fixture = readFileSync(new URL("../fixtures/DisplayInit.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "DisplayInit.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-display-init-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { DisplayInit } = await import(pathToFileURL(join(directory, "demo_DisplayInit.mjs")).href);
    const display = new DisplayInit();
    assert.deepEqual(display.filters, [0, 2]);
    assert.equal(display.numChildren, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs constructor statements in source order around super()", async () => {
  const fixture = readFileSync(new URL("../fixtures/ConstructorOrder.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "ConstructorOrder.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const emitted = result.files.get("demo_ConstructorOrder.mjs")!;
  // The super call must stay after the assignment that precedes it in the source.
  assert.match(emitted, /\(this\.state = "ready"\)[\s\S]*\$super\(this, ConstructorBase/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-constructor-order-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { ConstructorOrder } = await import(pathToFileURL(join(directory, "demo_ConstructorOrder.mjs")).href);
    const instance = new ConstructorOrder();
    // ConstructorBase's constructor dispatches into the override, which must already
    // see the value assigned before `super()`.
    assert.equal(instance.observed, "ready");
    assert.equal(instance.snapshot(), "ready");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs static accessors on the class object", async () => {
  const fixture = readFileSync(new URL("../fixtures/StaticAccessor.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "StaticAccessor.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-static-accessor-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { StaticAccessor } = await import(
      pathToFileURL(join(directory, "demo_StaticAccessor.mjs")).href
    );
    const descriptor = Object.getOwnPropertyDescriptor(StaticAccessor, "flag");
    assert.equal(typeof descriptor?.get, "function");
    assert.equal(typeof descriptor?.set, "function");
    assert.equal(StaticAccessor.flag, 0);
    StaticAccessor.flag = 7;
    assert.equal(StaticAccessor.flag, 7);
    // The constructor writes through the setter-only static accessor, which must run.
    new StaticAccessor();
    assert.ok(Array.isArray(StaticAccessor.queue));
    assert.equal(StaticAccessor.queue.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps the inherited getter when a subclass overrides only the setter", async () => {
  const fixture = readFileSync(new URL("../fixtures/AccessorOverride.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "AccessorOverride.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-accessor-override-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { AccessorChild } = await import(
      pathToFileURL(join(directory, "demo_AccessorChild.mjs")).href
    );
    const child = new AccessorChild();
    // The setter-only override must not shadow the inherited getter.
    assert.equal(child.callProcedure(), "function");
    child.procedure = null;
    assert.equal(child.callProcedure(), "function");
    const assigned = function assigned() {};
    child.procedure = assigned;
    assert.equal(child.procedure, assigned);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("describeType reports inherited interfaces inside the class factory", async () => {
  const fixture = readFileSync(new URL("../fixtures/DescribeInterfaces.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "DescribeInterfaces.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-describe-interfaces-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { ReflectProbe } = await import(pathToFileURL(join(directory, "demo_ReflectProbe.mjs")).href);
    const probe = new ReflectProbe();
    assert.equal(probe.hasFactory(), true);
    // MarkedChild does not declare IMarker itself; it inherits it from MarkedBase.
    assert.equal(probe.implementsInherited(), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("routes AS3 Proxy access and enumeration through flash_proxy methods", async () => {
  const fixture = readFileSync(new URL("../fixtures/ProxyMap.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "ProxyMap.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-proxy-map-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { ProxyMap } = await import(pathToFileURL(join(directory, "demo_ProxyMap.mjs")).href);
    const { ProxyProbe } = await import(pathToFileURL(join(directory, "demo_ProxyProbe.mjs")).href);
    const map = new ProxyMap();
    const probe = new ProxyProbe();
    probe.write(map, "a", "1");
    probe.write(map, "b", "2");
    assert.equal(probe.read(map, "a"), "1");
    assert.deepEqual(probe.names(map), ["a", "b"]);
    assert.deepEqual(probe.valuesOf(map), ["1", "2"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lowers and executes closures, try/catch/finally and switch", async () => {
  const fixture = readFileSync(new URL("../fixtures/Closures.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Closures.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const closuresModule = result.files.get("demo_Closures.mjs")!;
  assert.match(closuresModule, /\.bind\(this\)/);
  assert.match(closuresModule, /\$is\(__caught, GuardError\)/);
  assert.match(closuresModule, /switch \(/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-closures-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Closures } = await import(pathToFileURL(join(directory, "demo_Closures.mjs")).href);
    const closures = new Closures();

    const add = closures.makeAdder(2);
    assert.equal(add(1), 13);
    assert.equal(add(1), 26);
    assert.equal(closures.laterCapture()(), 7);

    assert.equal(closures.classify(1), "one");
    assert.equal(closures.classify(3), "few");
    assert.equal(closures.classify(9), "many");

    assert.equal(closures.guarded("guard"), "try-guard:guard-finally");
    assert.equal(closures.guarded("plain"), "try-error:plain-finally");
    assert.equal(closures.guarded("none"), "try-ok-finally");

    assert.equal(closures.rethrows("other"), "-string:text");
    assert.equal(closures.rethrows("guard"), "guard");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lowers for in, for each and labelled break/continue", async () => {
  const fixture = readFileSync(new URL("../fixtures/Iteration.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Iteration.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const iterationModule = result.files.get("demo_Iteration.mjs")!;
  assert.match(iterationModule, /for \(var key of \$forIn\(source\)\)/);
  assert.match(iterationModule, /for \(var value of \$forEach\(source\)\)/);
  assert.match(iterationModule, /outer: for \(/);
  assert.match(iterationModule, /continue outer;/);
  assert.match(iterationModule, /break outer;/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-iteration-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const iterationModulePath = await import(pathToFileURL(join(directory, "demo_Iteration.mjs")).href);
    const holderModule = await import(pathToFileURL(join(directory, "demo_KeyHolder.mjs")).href);
    const iteration = new iterationModulePath.Iteration();

    assert.equal(iteration.keysOf({ b: 2, a: 1 }), "a,b");
    assert.equal(iteration.valuesOf({ b: 2, a: 1 }), "1,2");
    assert.equal(iteration.indexCount([10, 20, 30]), 3);
    assert.equal(iteration.sum($vector("int", [1, 2, 3])), 6);
    assert.equal(iteration.firstKey({ only: 1 }, new holderModule.KeyHolder()), "only");
    assert.equal(iteration.labelled(), "0010");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds ByteArray and round-trips a binary packet", async () => {
  const fixture = readFileSync(new URL("../fixtures/Protocol.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Protocol.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-protocol-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Protocol } = await import(pathToFileURL(join(directory, "demo_Protocol.mjs")).href);
    const protocol = new Protocol();

    assert.equal(protocol.roundTrip(), "42|300|-70000|héllo|1.5|19|19");
    assert.equal(protocol.littleEndian(), "258");
    assert.equal(protocol.eof(), "EOFError");
    assert.equal(protocol.copy(), "2:12");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coerces typed locals before use, like Flash", async () => {
  const fixture = readFileSync(new URL("../fixtures/TypedLocal.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "TypedLocal.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-typed-local-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { TypedLocal } = await import(pathToFileURL(join(directory, "demo_TypedLocal.mjs")).href);
    assert.equal(new TypedLocal().lookup(), "35|101");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selects XML children by numeric index, like E4X", () => {
  const XML = $runtimeClass("XML");
  const xml = new XML("<w><a>1</a><b>2</b></w>");

  assert.equal(xml.child(0).length(), 1);
  assert.equal($string(xml.child(0)[0].text()), "1");
  assert.equal($string(xml.child(1)[0].text()), "2");
  assert.equal(xml.child(2).length(), 0);
  assert.equal(xml.child("b").length(), 1);
});

test("converts XML node-sets to numbers through their text value", () => {
  const XML = $runtimeClass("XML");
  const xml = new XML('<w style="101" treshold="10"><n>7</n><p><q>3</q></p></w>');

  assert.equal($uint(xml.attribute("style")), 101);
  assert.equal($int(xml.attribute("treshold")), 10);
  assert.equal($number(xml.child("n")), 7);
  assert.equal($string(xml.attribute("style")), "101");
});

test("reads child elements ahead of XML members and prints simple content as text", () => {
  const XML = $runtimeClass("XML");
  const xml = new XML(
    '<furnitype id="1"><name>Star rug</name><description>Lovely</description><empty/></furnitype>',
  );

  // Furni data reads `k.name` for its <name> child, so the child has to win over XML.name().
  assert.equal(typeof xml.name, "object");
  assert.equal($string(xml.name), "Star rug");
  assert.equal($string(xml.description), "Lovely");
  assert.equal($string(xml.empty), "");
  assert.equal($string(xml.child("name")), "Star rug");
  // Complex content still serializes, and toXMLString never simplifies.
  assert.match(xml.toString(), /^<furnitype id="1">/);
  assert.match(xml.toXMLString(), /<name>Star rug<\/name>/);
  assert.equal($string(xml.missing), "");
});

test("reads and writes ByteArray bytes through index access", async () => {
  const fixture = readFileSync(new URL("../fixtures/ByteArrayIndex.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "ByteArrayIndex.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-bytearray-index-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { ByteArrayIndex } = await import(pathToFileURL(join(directory, "demo_ByteArrayIndex.mjs")).href);
    const instance = new ByteArrayIndex();

    assert.equal(instance.readWrite(), "65|66|67|4|0|68");
    assert.equal(instance.decodeInPlace(), "bG9naW5fd2luZG93");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("treats Dictionary primitive keys as strings and coerces return values, like Flash", async () => {
  const fixture = readFileSync(new URL("../fixtures/DictionaryKeys.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "DictionaryKeys.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-dictionary-keys-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { DictionaryKeys } = await import(pathToFileURL(join(directory, "demo_DictionaryKeys.mjs")).href);
    const instance = new DictionaryKeys();

    assert.equal(instance.primitiveKeyAlias(), "ten|ten|hello");
    assert.equal(instance.enumerateKeys(), "10:a;20:b;");
    assert.equal(instance.hasMixedKeys(), "11");
    assert.equal(instance.objectKeysRemainDistinct(), "a|b|false");
    assert.equal(instance.numericReturnCoerced(), "12.5");
    assert.equal(instance.truncatedIntReturn(), "3");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds every runtime descriptor to the shared binding table", () => {
  for (const fqcn of $runtimeClassNames()) {
    assert.doesNotThrow(() => $runtimeClass(fqcn), `${fqcn} has a descriptor but no binding`);
  }
});

test("exposes Flash's class constants for input, display and filters", () => {
  assert.equal($runtimeClass("flash.ui.Keyboard").ENTER, 13);
  assert.equal($runtimeClass("flash.ui.Keyboard").BACKSPACE, 8);
  assert.equal($runtimeClass("flash.utils.Endian").LITTLE_ENDIAN, "littleEndian");
  assert.equal($runtimeClass("flash.utils.CompressionAlgorithm").ZLIB, "zlib");
  assert.equal($runtimeClass("flash.display.BitmapDataChannel").ALPHA, 8);
  assert.equal($runtimeClass("flash.filters.BitmapFilterQuality").LOW, 1);
  assert.equal($runtimeClass("flash.display.GradientType").LINEAR, "linear");
  assert.equal($runtimeClass("flash.display.SpreadMethod").PAD, "pad");
  assert.equal($runtimeClass("flash.display.InterpolationMethod").RGB, "rgb");
  assert.equal($runtimeClass("flash.display.PixelSnapping").AUTO, "auto");
  assert.equal($runtimeClass("flash.events.TextEvent").TEXT_INPUT, "textInput");
});

test("gives a TextField the Flash default text format", () => {
  const TextField = $runtimeClass("flash.text.TextField");
  const TextFormat = $runtimeClass("flash.text.TextFormat");
  const field = new TextField();

  assert.equal(field.defaultTextFormat.font, "Times New Roman");
  assert.equal(field.defaultTextFormat.size, 12);
  assert.equal(field.getTextFormat().font, "Times New Roman");

  field.setTextFormat(new TextFormat("Arial", 20, 0xff0000));
  assert.equal(field.getTextFormat().font, "Arial");
  assert.equal(field.defaultTextFormat.size, 20);

  field.text = "ab";
  field.appendText("cd");
  assert.equal(field.text, "abcd");
});

test("ByteArray grows, reads and writes across the data views", () => {
  const ByteArray = $runtimeClass("flash.utils.ByteArray");
  const IDataInput = $runtimeClass("flash.utils.IDataInput");
  const bytes = new ByteArray();

  assert.equal(bytes.length, 0);
  assert.equal(bytes.position, 0);
  assert.equal(bytes.endian, "bigEndian");
  assert.equal(bytes.objectEncoding, 3);
  assert.ok($is(bytes, IDataInput));

  bytes.position = 4;
  bytes.writeByte(9);
  assert.equal(bytes.length, 5);
  bytes.position = 0;
  assert.deepEqual(
    [bytes.readUnsignedByte(), bytes.readUnsignedByte(), bytes.readUnsignedByte(), bytes.readUnsignedByte(), bytes.readUnsignedByte()],
    [0, 0, 0, 0, 9],
  );

  bytes.clear();
  bytes.writeUnsignedInt(0xdeadbeef);
  bytes.writeDouble(2.5);
  bytes.writeBoolean(true);
  assert.equal(bytes.length, 13);
  assert.equal(bytes.bytesAvailable, 0);
  bytes.position = 0;
  assert.equal(bytes.bytesAvailable, 13);
  assert.equal(bytes.readUnsignedInt(), 0xdeadbeef);
  assert.equal(bytes.readDouble(), 2.5);
  assert.equal(bytes.readBoolean(), true);
  assert.equal(bytes.bytesAvailable, 0);

  assert.throws(() => bytes.readByte(), /End of file was encountered/);
  assert.throws(() => bytes.compress("lzma"), AS3RuntimeError);
  assert.throws(() => bytes.readObject(), AS3RuntimeError);
  assert.throws(() => (bytes.endian = "middleEndian"), TypeError);
});

test("compresses and decompresses ByteArray contents with the bundled codec", () => {
  const ByteArray = $runtimeClass("flash.utils.ByteArray");
  const text = "habbo-flash-runtime;".repeat(64);
  const collect = (bytes: any): Buffer => {
    bytes.position = 0;
    const collected: number[] = [];
    while (bytes.bytesAvailable > 0) collected.push(bytes.readUnsignedByte());
    return Buffer.from(collected);
  };

  const bytes = new ByteArray();
  bytes.writeUTFBytes(text);
  const original = bytes.length;
  bytes.compress();
  assert.ok(bytes.length < original);
  assert.equal(bytes.position, 0);
  assert.equal(inflateSync(collect(bytes)).toString("utf8"), text);

  bytes.uncompress();
  assert.equal(bytes.length, original);
  bytes.position = 0;
  assert.equal(bytes.readUTFBytes(bytes.length), text);

  // Node's zlib output decodes here, so the wrappers agree in both directions.
  const fromNode = new ByteArray();
  for (const byte of deflateSync(Buffer.from(text, "utf8"))) fromNode.writeByte(byte);
  fromNode.uncompress();
  fromNode.position = 0;
  assert.equal(fromNode.readUTFBytes(fromNode.length), text);

  const raw = new ByteArray();
  raw.writeUTFBytes(text);
  raw.deflate();
  assert.equal(inflateRawSync(collect(raw)).toString("utf8"), text);
  raw.inflate();
  raw.position = 0;
  assert.equal(raw.readUTFBytes(raw.length), text);

  const rawFromNode = new ByteArray();
  for (const byte of deflateRawSync(Buffer.from(text, "utf8"))) rawFromNode.writeByte(byte);
  rawFromNode.inflate();
  rawFromNode.position = 0;
  assert.equal(rawFromNode.readUTFBytes(rawFromNode.length), text);

  const corrupt = new ByteArray();
  corrupt.writeUTFBytes("not compressed data");
  assert.throws(() => corrupt.uncompress(), /error decompressing/);
});

test("compresses ByteArray contents from compiled code", async () => {
  const fixture = readFileSync(new URL("../fixtures/Compression.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Compression.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-compression-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Compression } = await import(pathToFileURL(join(directory, "demo_Compression.mjs")).href);
    const instance = new Compression();

    assert.match(instance.roundTrip(), /^\d+\|true\|true\|0$/);
    assert.equal(instance.rawRoundTrip(), "true|raw-deflate-payload");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coerces primitives at typed slots and 32-bit operators like Flash", async () => {
  const fixture = readFileSync(new URL("../fixtures/Primitives.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Primitives.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-primitives-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Primitives } = await import(pathToFileURL(join(directory, "demo_Primitives.mjs")).href);
    const instance = new Primitives();

    assert.equal(
      instance.coercions(),
      "3|-3|0|0|-1|4294967295|-2147483646|-2147483647|3.5|4294967294",
    );
    assert.equal(instance.operators(), "false|true|true|false|true|false|true|false|-2|8|-4|15");
    assert.equal(instance.typeofValues(), "xml|xml|object|function|number|string|object|undefined");
    assert.equal(instance.arity(), "2|2");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports typeof xml for XML and XMLList, and object for classes", () => {
  const XML = $runtimeClass("XML");
  const xml = new XML("<root><child/></root>");

  assert.equal($typeof(xml), "xml");
  assert.equal($typeof(xml.children()), "xml");
  assert.equal($typeof($runtimeClass("flash.utils.ByteArray")), "object");
  assert.equal($typeof(null), "object");
  assert.equal($typeof(3), "number");
  assert.equal($typeof("text"), "string");
  assert.equal($typeof(() => 1), "function");
});

test("rejects delete on a local variable like AS3", () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      public class DeleteLocal {
        public function DeleteLocal() {}
        public function run():void {
          var value:int = 1;
          delete value;
        }
      }
    }`,
    "DeleteLocal.as",
    { runtimeSpecifier },
  );

  assert.ok(
    result.diagnostics.some((diagnostic: any) => /must be a property/.test(diagnostic.message)),
  );
});

test("resolves in and delete through dictionaries, proxies and sealed members", async () => {
  const fixture = readFileSync(new URL("../fixtures/Membership.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Membership.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-membership-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Membership } = await import(pathToFileURL(join(directory, "demo_Membership.mjs")).href);
    const instance = new Membership();

    // Dictionary primitive keys use Flash's string form; object keys stay identity keys.
    assert.equal(instance.dictionaryMembership(), "true|true|true|true|false");
    assert.equal(instance.objectMembership(), "true|false|true|false|true");
    assert.equal(instance.deleteDynamic(), "true|false");
    // A declared field of a sealed class cannot be deleted.
    assert.equal(instance.deleteSealed(), "false|1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds Socket over a WebSocket transport", async () => {
  type Listener = (event: any) => void;

  class FakeWebSocket {
    binaryType = "blob";
    readonly listeners = new Map<string, Listener[]>();
    readonly sent: Uint8Array[] = [];
    closed = false;
    readonly url: string;

    constructor(url: string) {
      this.url = url;
    }

    addEventListener(type: string, listener: Listener): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    emit(type: string, event: any = {}): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    send(data: any): void {
      this.sent.push(new Uint8Array(data));
    }

    close(): void {
      this.closed = true;
      this.emit("close");
    }

    receive(bytes: Uint8Array): void {
      this.emit("message", { data: bytes.buffer });
    }
  }

  const created: FakeWebSocket[] = [];
  $setWebSocketFactory((url) => {
    const socket = new FakeWebSocket(url);
    created.push(socket);
    return socket;
  });

  const fixture = readFileSync(new URL("../fixtures/Packet.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Packet.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);

  const directory = mkdtempSync(join(tmpdir(), "as3js-socket-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Packet } = await import(pathToFileURL(join(directory, "demo_Packet.mjs")).href);
    const Socket = $runtimeClass("flash.net.Socket");
    const IDataInput = $runtimeClass("flash.utils.IDataInput");
    const socket = new Socket();
    const seen: string[] = [];
    socket.addEventListener("connect", () => seen.push("connect"));
    socket.addEventListener("socketData", () => seen.push("data"));
    socket.addEventListener("close", () => seen.push("close"));

    assert.ok($is(socket, IDataInput));
    socket.connect("example.test", 1234);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.url, "ws://example.test:1234");
    assert.equal(created[0]!.binaryType, "arraybuffer");
    assert.equal(socket.connected, false);

    created[0]!.emit("open");
    assert.equal(socket.connected, true);

    new Packet().write(socket, 7, "hi");
    assert.deepEqual([...created[0]!.sent[0]!], [0, 0, 0, 7, 0, 2, 104, 105]);

    created[0]!.receive(new Uint8Array([0, 0, 0, 42]));
    assert.equal(socket.bytesAvailable, 4);
    assert.equal(socket.readUnsignedInt(), 42);
    assert.deepEqual(seen, ["connect", "data"]);

    socket.close();
    assert.equal(socket.connected, false);
    assert.equal(created[0]!.closed, true);
    assert.deepEqual(seen, ["connect", "data", "close"]);
  } finally {
    $setWebSocketFactory(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds flash.ui.Mouse cursor and visibility", () => {
  const Mouse = $runtimeClass("flash.ui.Mouse");
  const MouseCursor = $runtimeClass("flash.ui.MouseCursor");
  assert.equal(MouseCursor.HAND, "hand");
  Mouse.cursor = MouseCursor.HAND;
  assert.equal(Mouse.cursor, "hand");
  assert.equal(Mouse.hide(), undefined);
  assert.equal(Mouse.show(), undefined);
});

test("exposes URLRequestMethod constants", () => {
  const URLRequestMethod = $runtimeClass("flash.net.URLRequestMethod");
  assert.equal(URLRequestMethod.GET, "GET");
  assert.equal(URLRequestMethod.POST, "POST");
});

test("installs the AS3 trace global", () => {
  assert.equal(typeof (globalThis as any).trace, "function");
  assert.equal((globalThis as any).trace("a", 1), undefined);
});

test("draws one BitmapData into another", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const source = new BitmapData(2, 2, true, 0);
  source.setPixel32(0, 0, 0xff102030);
  source.setPixel32(1, 1, 0x80405060);
  const target = new BitmapData(2, 2, true, 0);
  target.draw(source);
  assert.equal(target.getPixel32(0, 0), 0xff102030);
  assert.equal(target.getPixel32(1, 1), 0x80405060);
  assert.equal(target.getPixel32(1, 0), 0);
});

test("copies XML deeply and binds Shader with ShaderFilter", () => {
  const XML = $runtimeClass("XML");
  const original = new XML("<a x='1'><b>two</b></a>");
  const copy = original.copy();
  assert.notEqual(copy, original);
  assert.equal(copy.child("b").text(), "two");
  assert.equal(copy.attribute("x").toString(), "1");
  copy.appendChild(new XML("<c/>"));
  assert.equal(original.child("c").length(), 0);
  assert.equal(copy.child("c").length(), 1);

  const ByteArray = $runtimeClass("flash.utils.ByteArray");
  const Shader = $runtimeClass("flash.display.Shader");
  const ShaderFilter = $runtimeClass("flash.filters.ShaderFilter");
  const code = new ByteArray();
  const shader = new Shader(code);
  assert.equal(shader.byteCode, code);
  assert.equal(shader.precisionHint, "full");
  const filter = new ShaderFilter(shader);
  assert.equal(filter.shader, shader);
  assert.ok(filter instanceof $runtimeClass("flash.filters.BitmapFilter"));
});

test("reports the aggregation target as event.target like Flash's EventDispatcher", () => {
  const EventDispatcher = $runtimeClass("flash.events.EventDispatcher");
  const Event = $runtimeClass("flash.events.Event");
  const owner = { name: "owner" };
  const dispatcher = new EventDispatcher(owner);
  const targets: any[] = [];
  dispatcher.addEventListener("ping", (event: any) => targets.push(event.target));
  dispatcher.dispatchEvent(new Event("ping"));
  // `new EventDispatcher(target)` is how aggregated dispatchers (EventDispatcherWrapper) make
  // the wrapper, not the internal dispatcher, the event target.
  assert.equal(targets.length, 1);
  assert.equal(targets[0], owner);

  const standalone = new EventDispatcher();
  const selfTargets: any[] = [];
  standalone.addEventListener("ping", (event: any) => selfTargets.push(event.target));
  standalone.dispatchEvent(new Event("ping"));
  assert.equal(selfTargets[0], standalone);
});

test("reports an unavailable socket transport as IOErrorEvent instead of throwing", async () => {
  $setWebSocketFactory(() => {
    throw new Error("no route to host");
  });
  try {
    const Socket = $runtimeClass("flash.net.Socket");
    const socket = new Socket();
    const events: string[] = [];
    socket.addEventListener("ioError", (event: any) => events.push(event.text ?? "ioError"));
    // Flash reports transport failures asynchronously; connect() itself does not throw.
    socket.connect("example.test", 1234);
    assert.equal(socket.connected, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(events.length, 1);
    assert.match(events[0]!, /Unable to open ws:\/\/example\.test:1234/);
  } finally {
    $setWebSocketFactory(null);
  }
});

async function waitFor(check: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test("reports an invalid Socket port as IOError instead of building a bad URL", async () => {
  const Socket = $runtimeClass("flash.net.Socket");
  const socket = new Socket();
  let text = "";
  socket.addEventListener("ioError", (event: any) => {
    text = String(event.text);
  });
  const opened: string[] = [];
  socket.connect("127.0.0.1", NaN as unknown as number);
  await waitFor(() => text.length > 0, "no IOError for an invalid port");
  assert.match(text, /invalid port NaN/);
  assert.deepEqual(opened, []);
});

test("allows Socket.connect again after a failed attempt", async () => {
  const probe = await startEchoServer();
  const deadPort = probe.port;
  await probe.close();
  const server = await startEchoServer();
  try {
    const Socket = $runtimeClass("flash.net.Socket");
    const socket = new Socket();
    let errors = 0;
    socket.addEventListener("ioError", () => {
      errors += 1;
    });
    socket.connect("127.0.0.1", deadPort);
    await waitFor(() => errors > 0, "no IOError for the refused connection");
    socket.connect("127.0.0.1", server.port);
    await waitFor(() => socket.connected, "reconnect never connected");
    socket.close();
  } finally {
    await server.close();
  }
});

test("ignores NUL padding in a Socket host like the OS resolver does", async () => {
  const server = await startEchoServer();
  try {
    const Socket = $runtimeClass("flash.net.Socket");
    const socket = new Socket();
    socket.connect("127.0.0.1\u0000\u0000\u0000", server.port);
    await waitFor(() => socket.connected, "socket never connected");
    socket.close();
  } finally {
    await server.close();
  }
});

test("Socket exchanges binary frames with a real WebSocket server", async () => {
  const server = await startEchoServer();
  try {
    const Socket = $runtimeClass("flash.net.Socket");
    const socket = new Socket();
    const events: string[] = [];
    socket.addEventListener("connect", () => events.push("connect"));
    socket.addEventListener("socketData", () => events.push("data"));
    socket.addEventListener("close", () => events.push("close"));

    socket.connect("127.0.0.1", server.port);
    await waitFor(() => socket.connected, "socket never connected");

    socket.writeByte(0x2a);
    socket.writeInt(0x01020304);
    socket.writeUTF("hi");
    socket.flush();

    await waitFor(() => socket.bytesAvailable >= 9, "echo never arrived");
    assert.equal(socket.readByte(), 0x2a);
    assert.equal(socket.readInt(), 0x01020304);
    assert.equal(socket.readUTF(), "hi");
    assert.deepEqual(events, ["connect", "data"]);

    socket.close();
    await waitFor(() => events.includes("close"), "close event missing");
  } finally {
    await server.close();
  }
});

test("runtime values expose reflection and host timers", () => {
  const getTimer = $runtimeValue("flash.utils.getTimer");
  const getQualifiedClassName = $runtimeValue("flash.utils.getQualifiedClassName");
  const getQualifiedSuperclassName = $runtimeValue("flash.utils.getQualifiedSuperclassName");
  const getDefinitionByName = $runtimeValue("flash.utils.getDefinitionByName");
  const Point = $runtimeClass("flash.geom.Point");
  const Sprite = $runtimeClass("flash.display.Sprite");

  const started = getTimer();
  assert.equal(getQualifiedClassName(new Point(3, 4)), "flash.geom.Point");
  assert.equal(getQualifiedClassName(Point), "flash.geom.Point");
  assert.equal(getQualifiedClassName("x"), "String");
  assert.equal(getQualifiedClassName(2), "int");
  assert.equal(getQualifiedClassName(1.5), "Number");
  assert.equal(getQualifiedSuperclassName(new Sprite()), "flash.display.DisplayObjectContainer");
  assert.equal(getQualifiedSuperclassName(new Point()), null);
  assert.ok(getTimer() >= started);

  assert.equal(getDefinitionByName("flash.geom.Point"), Point);
  const built = new (getDefinitionByName("flash.geom.Point"))(5, 6);
  assert.deepEqual([built.x, built.y], [5, 6]);
  assert.throws(() => getDefinitionByName("no.such.Type"), ReferenceError);
  const describeType = $runtimeValue("flash.utils.describeType");
  assert.match(describeType(new Point(3, 4)).toString(), /<accessor name="length" access="readonly"/);
  assert.match(describeType(Point).toString(), /<variable name="x" type="Number"/);
});

test("compiles imported runtime value calls", async () => {
  const fixture = readFileSync(new URL("../fixtures/Reflection.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Reflection.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);

  const directory = mkdtempSync(join(tmpdir(), "as3js-reflection-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Reflection } = await import(pathToFileURL(join(directory, "demo_Reflection.mjs")).href);
    const reflection = new Reflection();

    assert.equal(reflection.monotonic(), true);
    assert.equal(reflection.className(), "flash.geom.Point");
    assert.equal(reflection.sameClass(), true);

    let fired = "";
    reflection.later((message: string) => {
      fired = message;
    });
    await waitFor(() => fired === "fired", "setTimeout callback never fired");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds Dictionary with bracket access and iteration", () => {
  const Dictionary = $runtimeClass("flash.utils.Dictionary");
  const dict = new Dictionary();

  dict["a"] = 1;
  dict["b"] = 2;
  assert.equal(dict["a"], 1);
  assert.equal(dict.has("b"), true);

  dict.set("c", 3);
  assert.equal(dict.get("c"), 3);
  assert.deepEqual($forIn(dict).sort(), ["a", "b", "c"]);
  assert.deepEqual($forEach(dict).sort(), [1, 2, 3]);

  delete dict["b"];
  assert.equal(dict.has("b"), false);
  assert.equal(dict.remove("c"), true);
  assert.equal(dict["missing"], undefined);

  const objectKey = {};
  dict.set(objectKey, "object");
  assert.equal(dict.get(objectKey), "object");
  assert.equal(dict.get({}), undefined);
  assert.ok(dict instanceof Dictionary);

  // Function keys must survive for-in / for-each, not be stringified.
  const listener = function listener() {};
  const listeners = new Dictionary();
  listeners.set(listener, null);
  assert.deepEqual($forIn(listeners), [listener]);
  assert.deepEqual($forEach(listeners), [null]);
  listeners.remove(listener);
  assert.deepEqual($forIn(listeners), []);
});

test("compiles Dictionary bracket access and for-in", async () => {
  const fixture = readFileSync(new URL("../fixtures/Lookup.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Lookup.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);

  const directory = mkdtempSync(join(tmpdir(), "as3js-dictionary-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Lookup } = await import(pathToFileURL(join(directory, "demo_Lookup.mjs")).href);
    assert.equal(new Lookup().roundTrip(), "ab|11|true|2");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds geometry classes ported from the reference runtime", async () => {
  const fixture = readFileSync(new URL("../fixtures/Geom.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Geom.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-geom-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Geom } = await import(pathToFileURL(join(directory, "demo_Geom.mjs")).href);
    const Point = $runtimeClass("flash.geom.Point");
    const Rectangle = $runtimeClass("flash.geom.Rectangle");
    const geom = new Geom();

    const moved = geom.move(new Point(1, 2), 3, 4);
    assert.ok(moved instanceof Point);
    assert.deepEqual([moved.x, moved.y], [4, 6]);
    assert.equal(geom.lengthOf(3, 4), 5);

    const bounds = geom.bounds();
    assert.ok(bounds instanceof Rectangle);
    assert.deepEqual([bounds.x, bounds.y, bounds.width, bounds.height], [60, 20, 50, 40]);

    const transformed = geom.transformed();
    assert.deepEqual([transformed.x, transformed.y], [22, 18]);

    assert.equal(geom.tint(), 0x336699);
    assert.equal(geom.span(new Rectangle(5, 5, 20, 10)), 20);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds Timer and dispatches TimerEvent", async () => {
  const Timer = $runtimeClass("flash.utils.Timer");
  const TimerEvent = $runtimeClass("flash.events.TimerEvent");
  const timer = new Timer(5, 2);
  const seen: string[] = [];
  timer.addEventListener(TimerEvent.TIMER, () => seen.push("timer"));
  timer.addEventListener(TimerEvent.TIMER_COMPLETE, () => seen.push("complete"));

  assert.equal(timer.delay, 5);
  assert.equal(timer.repeatCount, 2);
  assert.equal(timer.running, false);
  timer.start();
  assert.equal(timer.running, true);

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(seen, ["timer", "timer", "complete"]);
  assert.equal(timer.currentCount, 2);
  assert.equal(timer.running, false);
  assert.equal(TimerEvent.TIMER, "timer");
});

test("enumerates plain objects, arrays and Maps, but not sealed instances", () => {
  const Point = $runtimeClass("flash.geom.Point");

  assert.deepEqual($forIn({ b: 2, a: 1 }), ["b", "a"]);
  assert.deepEqual($forEach({ b: 2, a: 1 }), [2, 1]);
  assert.deepEqual($forIn([7, 8]), ["0", "1"]);
  assert.deepEqual($forEach([7, 8]), [7, 8]);
  assert.deepEqual($forIn(new Map([[2, "two"], [3, "three"]])), [2, 3]);
  assert.deepEqual($forEach(new Map([[2, "two"], [3, "three"]])), ["two", "three"]);
  assert.deepEqual($forIn(new Point(1, 2)), []);
  assert.deepEqual($forEach(new Point(1, 2)), []);
});

test("runs capture, target and bubble listeners in order", () => {
  const Event = $runtimeClass("flash.events.Event");
  const EventDispatcher = $runtimeClass("flash.events.EventDispatcher");
  const parent = new EventDispatcher();
  const child = new EventDispatcher();
  child.parent = parent;
  const phases: number[] = [];
  parent.addEventListener("ping", (event: any) => phases.push(event.eventPhase), true);
  child.addEventListener("ping", (event: any) => phases.push(event.eventPhase));
  parent.addEventListener("ping", (event: any) => phases.push(event.eventPhase));

  const event = new Event("ping", true);
  assert.equal(child.dispatchEvent(event), true);
  assert.deepEqual(phases, [1, 2, 3]);
  assert.equal(event.eventPhase, 0);
  assert.equal(Event.ENTER_FRAME, "enterFrame");
});

test("propagates stage membership and dispatches frame events", () => {
  const Event = $runtimeClass("flash.events.Event");
  const Stage = $runtimeClass("flash.display.Stage");
  const Sprite = $runtimeClass("flash.display.Sprite");
  const MovieClip = $runtimeClass("flash.display.MovieClip");
  const stage = new Stage();
  const parent = new Sprite();
  const child = new MovieClip();
  parent.addChild(child);

  const lifecycle: string[] = [];
  let resized = 0;
  parent.addEventListener(Event.ADDED_TO_STAGE, () => lifecycle.push(`parent:${parent.stage === stage}`));
  child.addEventListener(Event.ADDED_TO_STAGE, () => lifecycle.push(`child:${child.stage === stage}:${child.root === parent}`));
  stage.addEventListener(Event.RESIZE, () => { resized += 1; });

  stage.addChild(parent);
  assert.equal(parent.stage, stage);
  assert.equal(child.stage, stage);
  assert.equal(parent.root, parent);
  assert.equal(child.root, parent);
  assert.deepEqual(lifecycle, ["parent:true", "child:true:true"]);

  // A stage in a non-NO_SCALE mode reports the movie size, so setting the viewport is not a resize.
  $setStageSize(stage, 640, 480);
  assert.equal(stage.stageWidth, 640);
  assert.equal(stage.stageHeight, 480);
  assert.equal(resized, 0);

  // Ruffle's `build_matrices`: a NO_SCALE stage tracks the viewport and fires resize when the
  // derived stage size actually changes - and only then.
  stage.scaleMode = "noScale";
  assert.equal(resized, 0);
  $setStageSize(stage, 800, 600);
  assert.equal(stage.stageWidth, 800);
  assert.equal(stage.stageHeight, 600);
  assert.equal(resized, 1);
  $setStageSize(stage, 800, 600);
  assert.equal(resized, 1);

  const frames: string[] = [];
  stage.addEventListener(Event.ENTER_FRAME, (event: any) => frames.push(`stage:${event.type}`));
  child.addEventListener(Event.ENTER_FRAME, (event: any) => frames.push(`child:${event.type}`));
  child.addEventListener(Event.FRAME_CONSTRUCTED, (event: any) => frames.push(`child:${event.type}`));
  child.addEventListener(Event.EXIT_FRAME, (event: any) => frames.push(`child:${event.type}`));
  assert.equal(child.framesLoaded, 1);
  assert.equal(child.currentLabel, null);
  child.totalFrames = 3;
  child.gotoAndStop(1);
  assert.equal(child.isPlaying, false);
  child.nextFrame();
  assert.equal(child.currentFrame, 2);
  child.prevFrame();
  assert.equal(child.currentFrame, 1);
  child.gotoAndStop(99);
  assert.equal(child.currentFrame, 3);
  child.gotoAndPlay(0);
  assert.equal(child.currentFrame, 1);
  assert.equal(child.isPlaying, true);

  assert.equal($runFrame(stage), 1);
  assert.equal(child.currentFrame, 2);
  assert.deepEqual(frames, [
    "stage:enterFrame",
    "child:enterFrame",
    "child:frameConstructed",
    "child:exitFrame",
  ]);

  let removed = 0;
  child.addEventListener(Event.REMOVED_FROM_STAGE, () => { removed += 1; });
  stage.removeChild(parent);
  assert.equal(parent.stage, null);
  assert.equal(child.stage, null);
  assert.equal(removed, 1);
});

test("binds instance method references to their receiver", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      import flash.events.Event;
      import flash.events.EventDispatcher;
      public class Binder {
        public var seen:int;
        public function attach(target:EventDispatcher):void {
          target.addEventListener("ping", this.onPing);
          target.addEventListener("pong", onPong);
        }
        public function detach(target:EventDispatcher):void {
          target.removeEventListener("ping", this.onPing);
        }
        public function onPing(event:Event):void { seen += 1; }
        private function onPong(event:Event):void { seen += 10; }
      }
    }`,
    "Binder.as",
    { runtimeSpecifier },
  );

  assert.deepEqual(result.diagnostics, []);
  assert.match(result.files.get("demo_Binder.mjs")!, /\$bindMethod\(this, "onPing"\)/);
  const directory = mkdtempSync(join(tmpdir(), "as3js-bind-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Binder } = await import(pathToFileURL(join(directory, "demo_Binder.mjs")).href);
    const Event = $runtimeClass("flash.events.Event");
    const EventDispatcher = $runtimeClass("flash.events.EventDispatcher");
    const target = new EventDispatcher();
    const binder = new Binder();
    binder.attach(target);
    target.dispatchEvent(new Event("ping"));
    target.dispatchEvent(new Event("pong"));
    assert.equal(binder.seen, 11);
    binder.detach(target);
    target.dispatchEvent(new Event("ping"));
    assert.equal(binder.seen, 11);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("starts and stops a host frame loop", async () => {
  const Event = $runtimeClass("flash.events.Event");
  const Stage = $runtimeClass("flash.display.Stage");
  const stage = new Stage();
  let frames = 0;
  stage.addEventListener(Event.ENTER_FRAME, () => { frames += 1; });

  const loop = $startFrameLoop(stage, { frameRate: 240 });
  assert.equal(loop.stage, stage);
  assert.equal(stage.frameRate, 240);
  await new Promise((resolve) => setTimeout(resolve, 50));
  $stopFrameLoop(stage);
  assert.ok(frames > 0);

  const stopped = frames;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(frames, stopped);
});

test("keeps a hidden document's frame loop running with a timer", async () => {
  const Event = $runtimeClass("flash.events.Event");
  const Stage = $runtimeClass("flash.display.Stage");
  const stage = new Stage();
  let frames = 0;
  stage.addEventListener(Event.ENTER_FRAME, () => { frames += 1; });

  const host = globalThis as any;
  const hadDocument = "document" in host;
  const previousDocument = host.document;
  const previousRequestFrame = host.requestAnimationFrame;
  // A hidden tab keeps reporting visibilitychange but never invokes rAF callbacks.
  host.document = {
    visibilityState: "hidden",
    addEventListener() {},
    removeEventListener() {},
  };
  host.requestAnimationFrame = () => 1;
  try {
    $startFrameLoop(stage, { frameRate: 240 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(frames > 0);
  } finally {
    $stopFrameLoop(stage);
    if (hadDocument) host.document = previousDocument;
    else delete host.document;
    if (previousRequestFrame === undefined) delete host.requestAnimationFrame;
    else host.requestAnimationFrame = previousRequestFrame;
  }
});

test("executes XML literals, attributes, descendants and text", async () => {
  const fixture = readFileSync(new URL("../fixtures/Xml.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Xml.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.files.get("demo_Xml.mjs")!, /\$xmlLiteral\(/);
  assert.match(result.files.get("demo_Xml.mjs")!, /\$xmlDescendants\(/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-xml-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Xml } = await import(pathToFileURL(join(directory, "demo_Xml.mjs")).href);
    const xml = new Xml();
    assert.equal(xml.summary(), "2:1:two:12:2:c");

    const XML = $runtimeClass("XML");
    const manifest = new XML("<manifest><library /></manifest>");
    const component = new XML("<component><assets><asset name=\"a\" /></assets></component>");
    manifest.child("library").appendChild(component.child("assets"));
    assert.match(manifest.toString(), /<library><assets><asset name="a"\/><\/assets><\/library>/);
    manifest.appendChild(new XML("<child />"));
    assert.match(manifest.toString(), /<\/library><child\/><\/manifest>/);
    assert.deepEqual($forIn(component.child("assets").child("asset")), ["0"]);
    assert.deepEqual($forEach(component.child("assets").child("asset")).map((node: any) => node.attribute("name").toString()), ["a"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("describeType reports members, constants and the class name", async () => {
  const fixture = readFileSync(new URL("../fixtures/ReflectType.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "ReflectType.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);

  const directory = mkdtempSync(join(tmpdir(), "as3js-describe-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { ReflectType } = await import(pathToFileURL(join(directory, "demo_ReflectType.mjs")).href);
    const description = new ReflectType().describe();
    assert.match(description, /<type name="demo\.ReflectType"/);
    assert.match(description, /<variable name="label" type="String"/);
    assert.match(description, /<method name="greet" declaredBy="demo\.ReflectType" returnType="String"/);
    assert.match(description, /<constant name="TAG" type="String"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loads URLs with URLLoader and URLStream", async () => {
  const fixture = readFileSync(new URL("../fixtures/Net.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Net.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);

  const directory = mkdtempSync(join(tmpdir(), "as3js-net-"));
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(`hello-net:${request.url}`);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Net } = await import(pathToFileURL(join(directory, "demo_Net.mjs")).href);
    const net = new Net();
    assert.equal(net.encode(), "a=1+2&b=%26");

    net.loadText(`http://127.0.0.1:${port}/text`);
    net.loadStream(`http://127.0.0.1:${port}/stream`);
    await waitFor(() => net.loaded !== "" && net.streamed !== "", "network load timed out");
    assert.equal(net.loaded, "hello-net:/text");
    assert.equal(net.streamed, "hello-net:/stream");
    assert.equal(net.failed, "");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracks TextField selection and replaces the selected range", () => {
  const TextField = $runtimeClass("flash.text.TextField");
  const field = new TextField();
  field.text = "hello";
  field.setSelection(1, 4);
  assert.equal(field.selectionBeginIndex, 1);
  assert.equal(field.selectionEndIndex, 4);
  // Indices clamp to the text and stay ordered.
  field.setSelection(9, 2);
  assert.equal(field.selectionBeginIndex, 2);
  assert.equal(field.selectionEndIndex, 5);
  // Moving an index past the other collapses the selection onto it.
  field.selectionBeginIndex = 4;
  assert.equal(field.selectionBeginIndex, 4);
  assert.equal(field.selectionEndIndex, 5);
  field.selectionEndIndex = 2;
  assert.equal(field.selectionBeginIndex, 2);
  assert.equal(field.selectionEndIndex, 2);
  field.setSelection(0, 5);
  field.replaceSelectedText("bye");
  assert.equal(field.text, "bye");
  assert.equal(field.selectionBeginIndex, 3);
  assert.equal(field.selectionEndIndex, 3);
});

test("reuses a bitmap's blit surface until the bitmap changes", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const Bitmap = $runtimeClass("flash.display.Bitmap");
  const uploads: number[] = [];
  const fakeContext: any = {
    putImageData() {
      uploads.push(uploads.length + 1);
    },
    createImageData(width: number, height: number) {
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
  };
  const previousOffscreen = (globalThis as any).OffscreenCanvas;
  (globalThis as any).OffscreenCanvas = class {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return fakeContext;
    }
  };
  try {
    const data = new BitmapData(4, 4, true, 0xffff0000);
    const bitmap = new Bitmap(data);
    const blits: any[] = [];
    const context: any = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      scale() {},
      drawImage(canvas: any) {
        blits.push(canvas);
      },
    };
    $renderDisplay(bitmap, context);
    $renderDisplay(bitmap, context);
    assert.equal(blits.length, 2);
    // Two frames, one upload: the same surface is blitted again while the pixels are unchanged.
    assert.equal(blits[0], blits[1]);
    assert.equal(uploads.length, 1);

    data.fillRect({ x: 0, y: 0, width: 2, height: 2 }, 0xff00ff00);
    $renderDisplay(bitmap, context);
    // A write invalidates the surface: the pixels are uploaded again, on the same canvas.
    assert.equal(uploads.length, 2);
    assert.equal(blits[2], blits[1]);
  } finally {
    (globalThis as any).OffscreenCanvas = previousOffscreen;
  }
});

test("loads Sound bytes and refuses audio playback", async () => {
  const Sound = $runtimeClass("flash.media.Sound");
  const URLRequest = $runtimeClass("flash.net.URLRequest");
  const Event = $runtimeClass("flash.events.Event");
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "audio/mpeg" });
    response.end(new Uint8Array([1, 2, 3, 4, 5]));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const sound = new Sound();
    const complete = new Promise<void>((resolve) => {
      sound.addEventListener(Event.COMPLETE, () => resolve());
    });
    sound.load(new URLRequest(`http://127.0.0.1:${port}/sample.mp3`));
    await complete;
    assert.equal(sound.bytesLoaded, 5);
    assert.equal(sound.bytesTotal, 5);
    assert.equal(sound.isBuffering, false);
    assert.throws(
      () => sound.play(),
      (error: unknown) => (error as any)?.name === "AS3RuntimeError" && (error as any)?.api === "flash.media.Sound.play",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("renders shapes, text and bitmaps through a canvas context", async () => {
  const fixture = readFileSync(new URL("../fixtures/Render.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Render.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);

  const directory = mkdtempSync(join(tmpdir(), "as3js-render-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { Render } = await import(pathToFileURL(join(directory, "demo_Render.mjs")).href);
    const render = new Render();
    render.build();

    const calls: any[] = [];
    const context: any = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      globalAlpha: 1,
      font: "",
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      scale() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      quadraticCurveTo() {},
      closePath() {},
      fill() {},
      stroke() {},
      strokeRect() {},
      fillRect(x: number, y: number, width: number, height: number) {
        calls.push({ op: "rect", x, y, width, height, fill: this.fillStyle });
      },
      fillText(text: string, x: number, y: number) {
        calls.push({ op: "text", text, x, y, fill: this.fillStyle });
      },
      createImageData(width: number, height: number) {
        return { width, height, data: new Uint8ClampedArray(width * height * 4) };
      },
      putImageData(image: any, x: number, y: number) {
        calls.push({ op: "image", x, y, width: image.width, height: image.height });
      },
    };

    $renderDisplay(render.root, context);
    assert.deepEqual(
      calls.find((call) => call.op === "rect"),
      { op: "rect", x: 10, y: 20, width: 30, height: 40, fill: "#ff0000" },
    );
    // Flash's default text format is 12px: 2px gutter plus the host ascent (10px without font
    // metrics) puts the alphabetic baseline at y = 12.
    assert.deepEqual(
      calls.find((call) => call.op === "text"),
      { op: "text", text: "hi", x: 2, y: 12, fill: "#0000ff" },
    );
    assert.deepEqual(
      calls.find((call) => call.op === "image"),
      { op: "image", x: 0, y: 0, width: 2, height: 1 },
    );

    const BitmapData = $runtimeClass("flash.display.BitmapData");
    const Rectangle = $runtimeClass("flash.geom.Rectangle");
    const pixels = new BitmapData(2, 2);
    pixels.setPixel32(1, 1, 0xffff0000);
    assert.equal(pixels.getPixel32(1, 1), 0xffff0000);
    assert.equal(pixels.getPixel(1, 1), 0xff0000);
    pixels.fillRect(new Rectangle(0, 0, 2, 1), 0xff00ff00);
    assert.equal(pixels.getPixel(0, 0), 0x00ff00);
    assert.equal(pixels.getPixel(1, 0), 0x00ff00);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("maps points between local and global display coordinates", () => {
  const Sprite = $runtimeClass("flash.display.Sprite");
  const Point = $runtimeClass("flash.geom.Point");
  const parent = new Sprite();
  parent.x = 10;
  parent.y = 20;
  const child = new Sprite();
  child.x = 5;
  child.y = 5;
  child.scaleX = 2;
  child.scaleY = 2;
  parent.addChild(child);

  const global = child.localToGlobal(new Point(1, 1));
  assert.deepEqual([global.x, global.y], [17, 27]);
  const local = child.globalToLocal(new Point(17, 27));
  assert.deepEqual([Math.round(local.x), Math.round(local.y)], [1, 1]);
});

test("converts arrays with Vector.<T>(value)", async () => {
  const source = `package demo
{
    public class VectorCast
    {
        public function numbers(items:Array):Vector.<int>
        {
            return Vector.<int>(items);
        }
    }
}`;
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(source, "VectorCast.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);

  const directory = mkdtempSync(join(tmpdir(), "as3js-vector-cast-"));
  try {
    for (const [file, text] of result.files) writeFileSync(join(directory, file), text);
    const { VectorCast } = await import(pathToFileURL(join(directory, "demo_VectorCast.mjs")).href);
    const numbers = new VectorCast().numbers([1, 2, 3]);
    assert.deepEqual(numbers, [1, 2, 3]);
    assert.equal((numbers as any).__elementType, "int");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("decodes embedded PNG bitmaps synchronously", () => {
  const bytes = new Uint8Array(readFileSync(new URL("../fixtures/assets/pixel.png", import.meta.url)));
  const decoded = decodePng(bytes);
  assert.ok(decoded);
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.equal(decoded.pixels[0], 0xffff0000);
  assert.equal(decodePng(new Uint8Array([1, 2, 3])), null);
});

test("paints gradient and bitmap graphics fills", () => {
  const Sprite = $runtimeClass("flash.display.Sprite");
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const Matrix = $runtimeClass("flash.geom.Matrix");

  const shape = new Sprite();
  shape.graphics.beginGradientFill("linear", [0xff0000, 0x0000ff], [1, 0.5], [0, 255], new Matrix(2, 0, 0, 1, 10, 20));
  shape.graphics.drawRect(0, 0, 10, 10);
  shape.graphics.endFill();

  const calls: any[] = [];
  const context: any = {
    fillStyle: "",
    globalAlpha: 1,
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    fillRect(x: number, y: number, width: number, height: number) {
      calls.push({ op: "rect", x, y, width, height, fill: this.fillStyle });
    },
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      const gradient: any = { x0, y0, x1, y1, stops: [] as any[] };
      gradient.addColorStop = (offset: number, color: string) => gradient.stops.push({ offset, color });
      return gradient;
    },
  };

  $renderDisplay(shape, context);
  const drawn = calls.find((call) => call.op === "rect");
  assert.ok(drawn);
  // The gradient spans Flash's 1638.4-unit box placed by the fill matrix.
  assert.equal(drawn.fill.x0, 10 - 819.2 * 2);
  assert.equal(drawn.fill.y0, 20);
  assert.equal(drawn.fill.x1, 10 + 819.2 * 2);
  assert.deepEqual(drawn.fill.stops, [
    { offset: 0, color: "rgba(255,0,0,1)" },
    { offset: 1, color: "rgba(0,0,255,0.5)" },
  ]);

  // A bitmap fill records its matrix and no longer aborts; without a host canvas it paints nothing.
  const data = new BitmapData(2, 2);
  const bitmapShape = new Sprite();
  bitmapShape.graphics.beginBitmapFill(data, new Matrix(3, 0, 0, 3, 7, 9), false, true);
  bitmapShape.graphics.drawRect(0, 0, 4, 4);
  bitmapShape.graphics.endFill();
  $renderDisplay(bitmapShape, context);
});

test("computes display bounds from graphics and children", () => {
  const Sprite = $runtimeClass("flash.display.Sprite");
  const child = new Sprite();
  child.graphics.beginFill(0xff0000);
  child.graphics.drawRect(0, 0, 20, 10);
  child.graphics.endFill();
  child.x = 5;
  child.y = 7;

  const parent = new Sprite();
  parent.addChild(child);
  assert.equal(child.width, 20);
  assert.equal(child.height, 10);
  assert.equal(parent.width, 20);
  assert.equal(parent.height, 10);

  const stage = $runtimeClass("flash.display.Stage");
  const root = new stage();
  $setStageSize(root, 800, 600);
  assert.equal(root.width, 800);
  assert.equal(root.height, 600);

  const BitmapAsset = $runtimeClass("mx.core.BitmapAsset");
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const Embedded = $class({
    name: "test.EmbeddedBitmap",
    abi: 1,
    base: () => BitmapAsset,
    interfaces: () => [],
    flags: { final: false, dynamic: false },
    metadata: [],
    fields: {},
    accessors: {},
    methods: {},
    statics: {},
    staticValues: {},
    ctor: { params: [], fn: function() {} },
  });
  const bitmap = new Embedded();
  bitmap.bitmapData = new BitmapData(32, 16);
  const holder = new Sprite();
  holder.addChild(bitmap);
  assert.equal(bitmap.width, 32);
  assert.equal(bitmap.height, 16);
  assert.equal(holder.width, 32);
  assert.equal(holder.height, 16);
});

test("bundles all generated modules into one ES module", async () => {
  const fixture = readFileSync(new URL("../fixtures/Backend.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "Backend.as", { runtimeSpecifier, bundle: true });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual([...result.files.keys()], ["app.js", "app.js.map", "manifest.json"]);
  assert.equal(result.manifest.entry, "demo.Base");

  const bundle = result.files.get("app.js")!;
  assert.doesNotMatch(bundle, /from "\.\//);
  assert.match(bundle, /export \{ Base, Child, IGreeter \}/);
  assert.equal(bundle.match(/from "file:\/\/.*index\.ts"/g)?.length, 1);

  const directory = mkdtempSync(join(tmpdir(), "as3js-bundle-"));
  try {
    writeFileSync(join(directory, "app.js"), bundle);
    const { Child } = await import(pathToFileURL(join(directory, "app.js")).href);
    const child = new Child(3);
    assert.equal(child.describe(), "base:4:4");
    assert.equal(child.doubled, 9);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("emits source maps and a project manifest", () => {
  const fixture = readFileSync(new URL("../fixtures/Render.as", import.meta.url), "utf8");
  const result = compileSource(fixture, "Render.as", { bundle: true });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual([...result.files.keys()], ["app.js", "app.js.map", "manifest.json"]);
  assert.equal(result.manifest.entry, "demo.Render");
  assert.equal(result.manifest.classes[0]?.entry, true);
  assert.match(result.files.get("app.js")!, /sourceMappingURL=app\.js\.map/);

  const map = JSON.parse(result.files.get("app.js.map")!) as any;
  assert.equal(map.version, 3);
  assert.equal(map.file, "app.js");
  assert.deepEqual(map.sources, ["Render.as"]);
  assert.match(map.sourcesContent[0], /class Render/);
  assert.ok(map.mappings.length > 0);

  const manifest = JSON.parse(result.files.get("manifest.json")!) as any;
  assert.equal(manifest.format, "as3js-manifest");
  assert.equal(manifest.entry, "demo.Render");
  assert.equal(manifest.bundle, "app.js");
  assert.equal(manifest.classes[0].file, "app.js");
});

test("loads a .pop through the runtime AssetManager", async () => {
  const directory = mkdtempSync(join(tmpdir(), "as3js-runtime-pop-"));
  mkdirSync(join(directory, "images"));
  writeFileSync(join(directory, "images", "note.txt"), "hello runtime pop");
  const archive = createPopFromDirectory(directory, { bundle: "app" });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(archive.bytes);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const manager = new AssetManager();
    const loaded = await manager.loadBundle("app", `http://127.0.0.1:${port}/app.pop`);
    assert.equal(loaded.manifest.bundle, "app");
    assert.equal(manager.isBundleLoaded("app"), true);
    assert.equal(loaded.manifest.assets[0]?.name, "images/note.txt");
    assert.equal(manager.getText("images/note.txt"), "hello runtime pop");
    assert.equal(manager.getText("note.txt"), "hello runtime pop");
    assert.equal(
      manager.getText("images/note.txt"),
      new TextDecoder().decode(loaded.get("images/note.txt")!),
    );
    assert.equal(PopArchive.fromBytes(archive.bytes).asset("note.txt")?.kind, "text");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("constructs [Embed] bitmap and byte-array classes from AssetManager", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const directory = mkdtempSync(join(tmpdir(), "as3js-embed-"));
  const assets = createPopFromDirectory(join(process.cwd(), "tests/fixtures/assets"), { bundle: "app" });
  const manager = new AssetManager();
  manager.addBundle("app", PopArchive.fromBytes(assets.bytes));
  $setAssetManager(manager);
  try {
    for (const fixture of ["EmbedBitmap", "EmbedBytes"]) {
      const source = readFileSync(new URL(`../fixtures/${fixture}.as`, import.meta.url), "utf8");
      const result = compileSource(source, `${fixture}.as`, { runtimeSpecifier });
      assert.deepEqual(result.diagnostics, []);
      for (const [file, text] of result.files) writeFileSync(join(directory, file), text);
    }

    const { EmbedBitmap } = await import(pathToFileURL(join(directory, "demo_EmbedBitmap.mjs")).href);
    const bitmap = new EmbedBitmap();
    assert.equal(bitmap.bitmapData.width, 1);
    assert.equal(bitmap.bitmapData.height, 1);

    const { EmbedBytes } = await import(pathToFileURL(join(directory, "demo_EmbedBytes.mjs")).href);
    const bytes = new EmbedBytes();
    assert.equal(
      bytes.readUTFBytes(bytes.length),
      readFileSync(join(process.cwd(), "tests/fixtures/assets/manifest.xml"), "utf8"),
    );
  } finally {
    $setAssetManager(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports host loader progress through LoaderInfo", () => {
  const LoaderInfo = $runtimeClass("flash.display.LoaderInfo");
  const Event = $runtimeClass("flash.events.Event");
  const ProgressEvent = $runtimeClass("flash.events.ProgressEvent");
  const loaderInfo = new LoaderInfo();
  const events: any[] = [];
  loaderInfo.addEventListener(ProgressEvent.PROGRESS, (event: any) => events.push(event));
  loaderInfo.addEventListener(Event.COMPLETE, (event: any) => events.push(event));

  $setLoaderProgress(loaderInfo, 50, 100);
  assert.equal(loaderInfo.bytesLoaded, 50);
  assert.equal(loaderInfo.bytesTotal, 100);
  assert.equal(events.length, 1);
  assert.equal(events[0].bytesLoaded, 50);
  assert.equal(events[0].bytesTotal, 100);

  $setLoaderProgress(loaderInfo, 150, 100, true);
  assert.equal(loaderInfo.bytesLoaded, 100);
  assert.equal(events.length, 3);
  assert.equal(events[1].type, ProgressEvent.PROGRESS);
  assert.equal(events[2].type, Event.COMPLETE);
  assert.throws(() => $setLoaderProgress(null, 0, 0), AS3RuntimeError);
});

test("exposes Flash Error.getStackTrace on runtime errors", () => {
  const error = $error("TypeError", "bad value") as any;
  assert.equal(typeof error.getStackTrace, "function");
  assert.match(error.getStackTrace(), /bad value/);
  const ErrorClass = $runtimeClass("Error");
  const constructed = new ErrorClass("boom");
  assert.match(constructed.getStackTrace(), /boom/);
});

test("keeps quoted object-literal keys unquoted", async () => {
  const source = `package demo {
    public class ObjectKeyFixture {
      public static function run():String {
        var probe:Object = {"type": "complete", "callback": 1};
        return String(probe.type) + ":" + String(probe["callback"]);
      }
    }
  }`;
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(source, "ObjectKeyFixture.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);
  const emitted = [...result.files.values()].join("\n");
  assert.ok(!emitted.includes('\'"type"\''), emitted.slice(0, 600));
  const directory = mkdtempSync(join(tmpdir(), "as3js-object-key-"));
  try {
    for (const [file, text] of result.files) writeFileSync(join(directory, file), text);
    const { ObjectKeyFixture } = await import(
      pathToFileURL(join(directory, "demo_ObjectKeyFixture.mjs")).href
    );
    assert.equal(ObjectKeyFixture.run(), "complete:1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds flash.errors.IllegalOperationError so typed catches match", async () => {
  const ErrorClass = $runtimeClass("flash.errors.IllegalOperationError");
  const error = new ErrorClass("nope");
  assert.equal(error.name, "IllegalOperationError");
  assert.equal(error.message, "nope");
  assert.ok(error instanceof Error);
  assert.ok($runtimeClassNames().includes("flash.errors.IllegalOperationError"));

  const source = `package demo {
    import flash.errors.IllegalOperationError;
    public class IllegalOpFixture {
      public static function run():String {
        try { throw new IllegalOperationError("boom"); }
        catch (e:IllegalOperationError) { return "caught:" + e.message; }
        return "missed";
      }
    }
  }`;
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(source, "IllegalOpFixture.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-illegalop-"));
  try {
    for (const [file, text] of result.files) writeFileSync(join(directory, file), text);
    const { IllegalOpFixture } = await import(
      pathToFileURL(join(directory, "demo_IllegalOpFixture.mjs")).href
    );
    assert.equal(IllegalOpFixture.run(), "caught:boom");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exposes FlashVars through loaderInfo.parameters", async () => {
  $setExternalVariables({ mode: "test", count: 3 });
  const fixture = readFileSync(new URL("../fixtures/ExternalVars.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "ExternalVars.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);
  const directory = mkdtempSync(join(tmpdir(), "as3js-vars-"));
  try {
    for (const [file, source] of result.files) writeFileSync(join(directory, file), source);
    const { ExternalVars } = await import(pathToFileURL(join(directory, "demo_ExternalVars.mjs")).href);
    assert.equal(new ExternalVars().describe(), "test:3");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lowers super property writes and updates through the runtime", async () => {
  const fixture = readFileSync(new URL("../fixtures/SuperSet.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "SuperSet.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);
  const moduleSource = [...result.files].find(([file]) => file.endsWith("demo_SuperSet.mjs"))?.[1];
  assert.match(moduleSource ?? "", /\$superSet\(this/);
  assert.match(moduleSource ?? "", /\$superUpdate\(this/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-super-set-"));
  try {
    for (const [file, source] of result.files) writeFileSync(join(directory, file), source);
    const { SuperSet } = await import(pathToFileURL(join(directory, "demo_SuperSet.mjs")).href);
    const instance = new SuperSet();
    instance.value = 41;
    assert.equal(instance.value, 42);
    assert.equal(instance.bump(3), 45);
    assert.equal(instance.postfix(), 45);
    assert.equal(instance.value, 46);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("writes XML attributes through computed and dotted access", async () => {
  const fixture = readFileSync(new URL("../fixtures/XmlAttribute.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "XmlAttribute.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);
  const moduleSource = [...result.files].find(([file]) => file.endsWith("demo_XmlAttribute.mjs"))?.[1];
  assert.match(moduleSource ?? "", /\$xmlSetAttribute\(/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-xml-attribute-"));
  try {
    for (const [file, source] of result.files) writeFileSync(join(directory, file), source);
    const { XmlAttribute } = await import(pathToFileURL(join(directory, "demo_XmlAttribute.mjs")).href);
    assert.equal(new XmlAttribute().write(), "plain:computed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("round-trips DEFLATE-compressed .pop entries", () => {
  const text = new TextEncoder().encode("deflate me ".repeat(200));
  const archive = buildPop([{ source: "text/note.txt", data: text }], { compression: "auto" });
  assert.equal(archive.manifest.assets[0]?.compression, "deflate");
  assert.ok(archive.bytes.length < text.length);
  const read = readPopArchive(archive.bytes);
  assert.equal(read.manifest.assets[0]?.compression, "deflate");
  assert.equal(new TextDecoder().decode(read.entries.get("assets/" + archive.manifest.assets[0]!.sha256 + ".txt")!), "deflate me ".repeat(200));
});

test("splits assets into dependent lazy .pop bundles", () => {
  const files = ["a", "b", "c"].map((name) => ({
    source: `text/${name}.txt`,
    data: new TextEncoder().encode(`${name}:`.repeat(100)),
  }));
  const bundles = buildPopSet(files, { maxAssetsPerBundle: 2, compression: "auto" });
  assert.equal(bundles.length, 2);
  assert.equal(buildPopSet([]).length, 1);
  assert.equal(buildPopSet([])[0]?.manifest.assets.length, 0);
  assert.equal(bundles[0]?.manifest.bundle, "app");
  assert.equal(bundles[1]?.manifest.bundle, "app-2");
  assert.deepEqual(bundles[1]?.manifest.dependencies, ["app"]);
  assert.equal(bundles.reduce((total, bundle) => total + bundle.manifest.assets.length, 0), 3);
  const read = readPopArchive(bundles[1]!.bytes);
  assert.equal(read.manifest.dependencies[0], "app");
  assert.ok(read.manifest.assets.some((asset) => asset.source === "text/c.txt"));
});

test("maps unique module-manifest names to archive aliases", () => {
  const encoder = new TextEncoder();
  const files = [
    {
      source: "binaryData/Test_manifest.bin",
      data: encoder.encode('<manifest><assets><asset name="logo"/><asset name="shared"/><asset name="missing"/></assets></manifest>'),
    },
    { source: "binaryData/Test_logo.txt", data: encoder.encode("logo bytes") },
    {
      source: "binaryData/Other_manifest.bin",
      data: encoder.encode('<manifest><assets><asset name="shared"/></assets></manifest>'),
    },
    { source: "binaryData/Test_shared.txt", data: encoder.encode("test shared") },
    { source: "binaryData/Other_shared.txt", data: encoder.encode("other shared") },
  ];
  const archive = buildPop(files, { compression: "auto" });
  const logo = archive.manifest.assets.find((asset) => asset.source === "binaryData/Test_logo.txt")!;
  assert.ok(logo.aliases.includes("logo"));
  assert.equal(logo.aliases.includes("missing"), false);
  assert.equal(archive.manifest.assets.some((asset) => asset.aliases.includes("shared")), false);

  const read = readPopArchive(archive.bytes);
  assert.ok(read.entries.has(logo.entry));
  assert.equal(PopArchive.fromBytes(archive.bytes).text("logo"), "logo bytes");
});

test("reports the authored movie size until NO_SCALE, like the player", () => {
  const Event = $runtimeClass("flash.events.Event");
  const Stage = $runtimeClass("flash.display.Stage");
  const stage = new Stage();
  let resized = 0;
  stage.addEventListener(Event.RESIZE, () => { resized += 1; });

  // The authored movie size stands in for the SWF header a player reads before the stage is built.
  $setStageMovieSize(stage, 1024, 768);
  assert.equal(stage.stageWidth, 1024);
  assert.equal(stage.stageHeight, 768);

  // `showAll` reports the movie size, so changing the viewport alone is not a resize.
  $setStageSize(stage, 640, 480);
  assert.equal(stage.stageWidth, 1024);
  assert.equal(stage.stageHeight, 768);
  assert.equal(resized, 0);

  // Switching to NO_SCALE changes the derived size once, and Flash dispatches resize for that.
  stage.scaleMode = "noScale";
  assert.equal(stage.stageWidth, 640);
  assert.equal(stage.stageHeight, 480);
  assert.equal(resized, 1);
  stage.scaleMode = "noScale";
  assert.equal(resized, 1);
});

test("emits a generic browser launcher", () => {
  const boot = browserBoot({ bundle: "app.js" });
  assert.match(boot, /manifest\.json/);
  assert.match(boot, /\$setBaseUrl/);
  assert.match(boot, /\$getClass/);
  assert.match(boot, /\$startFrameLoop/);
  assert.match(boot, /globalThis\.__as3js\.frames/);
  // The stage must start at the CSS layout size, not the canvas's 300x150 default
  // backing store, or the first layout pass (splash centering) is offset.
  assert.ok(
    boot.indexOf("canvas.clientWidth") < boot.indexOf("$setStageSize(stage"),
    "stage size must come from the CSS box before $setStageSize",
  );
  // The authored size is applied before the viewport, so `showAll`-class modes report the movie size
  // and the client's own NO_SCALE switch is a real resize, exactly as a player behaves.
  assert.ok(boot.indexOf("$setStageMovieSize(stage") < boot.indexOf("$setStageSize(stage"),
    "authored movie size must be applied before the viewport");
  assert.match(boot, /manifest\.stage/);
  // The player lays the stage out after the SWF's first frame: the viewport is applied once the root
  // exists, so a client that pins its layout in a Stage.RESIZE handler receives that resize.
  assert.ok(boot.indexOf("$createRoot(entry") < boot.lastIndexOf("$setStageSize(stage"),
    "the viewport must be applied after the root is constructed");
  assert.match(boot, /authoredStage/);
  assert.equal((boot.match(/\$setLoaderProgress\(/g) ?? []).length, 2);
  assert.doesNotMatch(boot, /Habbo/);
  assert.match(browserIndex(), /src="\.\/boot\.js"/);
  assert.match(browserIndex({ host: "host.js" }), /<script src="\.\/host\.js"><\/script>/);
});

test("packs assets into a deterministic .pop archive", () => {
  const directory = mkdtempSync(join(tmpdir(), "as3js-pop-"));
  try {
    mkdirSync(join(directory, "text"), { recursive: true });
    writeFileSync(join(directory, "text", "note.txt"), "hello pop");
    writeFileSync(join(directory, "image.bin"), new Uint8Array([1, 2, 3, 4]));
    writeFileSync(join(directory, "copy-image.bin"), new Uint8Array([1, 2, 3, 4]));

    const first = createPopFromDirectory(directory, { bundle: "app" });
    const second = createPopFromDirectory(directory, { bundle: "app" });
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.manifest.assets.length, 2);

    const archive = readPopArchive(first.bytes);
    assert.ok(archive.entries.has("pop.json"));
    const textAsset = archive.manifest.assets.find((asset) => asset.source === "text/note.txt")!;
    assert.equal(new TextDecoder().decode(archive.entries.get(textAsset.entry)!), "hello pop");
    assert.equal(textAsset.kind, "text");
    assert.equal(textAsset.mime, "text/plain");
    const duplicate = archive.manifest.assets.find((asset) =>
      asset.name === "copy-image.bin" || asset.source === "copy-image.bin")!;
    assert.ok(duplicate.aliases.includes("image.bin"));
    assert.equal(duplicate.compression, "store");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function swfBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function swfU16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
}

function swfU32(value: number): Uint8Array {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

function swfConcat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function swfTag(code: number, payload: Uint8Array): Uint8Array {
  // TagCodeAndLength packs the 10-bit code high and the 6-bit length low.
  if (payload.length >= 63) {
    return swfConcat([swfU16((code << 6) | 0x3f), swfU32(payload.length), payload]);
  }
  return swfConcat([swfU16((code << 6) | payload.length), payload]);
}

function swfDefineBinary(id: number, text: string): Uint8Array {
  return swfTag(87, swfConcat([swfU16(id), swfU32(0), swfBytes(text)]));
}

function swfDefineLossless2(id: number, width: number, height: number, colors: number[]): Uint8Array {
  const raw = new Uint8Array(colors.length * 4);
  colors.forEach((color, index) => {
    raw[index * 4] = (color >>> 24) & 0xff;
    raw[index * 4 + 1] = (color >>> 16) & 0xff;
    raw[index * 4 + 2] = (color >>> 8) & 0xff;
    raw[index * 4 + 3] = color & 0xff;
  });
  return swfTag(
    36,
    swfConcat([
      swfU16(id),
      Uint8Array.of(5),
      swfU16(width),
      swfU16(height),
      new Uint8Array(deflateSync(Buffer.from(raw))),
    ]),
  );
}

function swfSymbolClass(entries: Array<[number, string]>): Uint8Array {
  const parts: Uint8Array[] = [swfU16(entries.length)];
  for (const [id, name] of entries) parts.push(swfU16(id), swfBytes(name), Uint8Array.of(0));
  return swfTag(76, swfConcat(parts));
}

function swfBuild(tags: Uint8Array[], compressed: boolean): Uint8Array {
  const body = swfConcat([
    // RECT with Nbits=1 in the high bits (SWF bit fields are MSB-first), 24 fps, 1 frame.
    Uint8Array.of(0x08, 0x00, 0x00, 0x18, 0x01, 0x00),
    ...tags,
    swfTag(0, new Uint8Array(0)),
  ]);
  const header = new Uint8Array(8);
  header.set(swfBytes(compressed ? "CWS" : "FWS"));
  header[3] = 10;
  new DataView(header.buffer).setUint32(4, 8 + body.length, true);
  return swfConcat([header, compressed ? new Uint8Array(deflateSync(Buffer.from(body))) : body]);
}

const SWF_MANIFEST =
  '<library><assets><asset name="Test_logo" type="image/png"/></assets></library>';

function swfLibraryBytes(compressed = true): Uint8Array {
  return swfBuild(
    [
      swfDefineBinary(1, SWF_MANIFEST),
      swfDefineLossless2(2, 2, 1, [0xffff0000, 0xff00ff00]),
      swfSymbolClass([[1, "Test_manifest"], [2, "Test_logo"]]),
      swfTag(82, Uint8Array.of(1, 2, 3, 4)),
    ],
    compressed,
  );
}

test("reads FWS and CWS asset-library SWFs into symbols", () => {
  for (const compressed of [false, true]) {
    const library = parseSwf(swfLibraryBytes(compressed));
    assert.equal(library.version, 10);
    assert.equal(library.symbols.length, 2);
    assert.equal(new TextDecoder().decode(library.manifest!), SWF_MANIFEST);
    const logo = library.symbols.find((symbol) => symbol.className === "Test_logo")!;
    assert.equal(logo.kind, "image");
    assert.equal(logo.image?.width, 2);
    assert.equal(logo.image?.height, 1);
    assert.deepEqual([...(logo.image?.pixels ?? [])], [0xffff0000, 0xff00ff00]);
  }
  assert.throws(() => parseSwf(Uint8Array.of(1, 2, 3)), /Truncated SWF header/);
  assert.throws(() => parseSwf(swfConcat([swfBytes("ZWS"), new Uint8Array(8)])), /LZMA/);
});

test("loads an asset-library SWF through Loader into an application domain", async () => {
  const swf = swfLibraryBytes();
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/testlib.swf")) {
      response.writeHead(200, { "content-type": "application/x-shockwave-flash" });
      response.end(swf);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/testlib.swf`;
  try {
    const Loader = $runtimeClass("flash.display.Loader");
    const LoaderInfo = $runtimeClass("flash.display.LoaderInfo");
    const URLRequest = $runtimeClass("flash.net.URLRequest");
    const loader = new Loader();
    const info = loader.contentLoaderInfo;
    assert.ok(info instanceof LoaderInfo);
    assert.equal(info.loader, loader);
    const complete = new Promise<void>((resolve, reject) => {
      info.addEventListener("complete", () => resolve());
      info.addEventListener("ioError", (event: any) => reject(new Error(event.text)));
    });
    loader.load(new URLRequest(url));
    await complete;

    assert.equal(info.url, url);
    assert.equal(info.bytesTotal > 0, true);
    assert.equal(info.bytesLoaded, info.bytesTotal);
    assert.equal(loader.content.loaderInfo, info);
    const domain = info.applicationDomain;
    assert.equal(domain.hasDefinition("testlib"), true);
    assert.equal(domain.hasDefinition("Test_logo"), true);
    assert.equal(domain.hasDefinition("Missing_symbol"), false);
    assert.throws(() => domain.getDefinition("Missing_symbol"), /was not found/);

    const Root = domain.getDefinition("testlib");
    const manifest = new Root.manifest();
    assert.equal(manifest.readUTFBytes(manifest.length), SWF_MANIFEST);
    const logo = new Root.Test_logo();
    assert.equal(logo.bitmapData.width, 2);
    assert.equal(logo.bitmapData.height, 1);
    assert.equal(logo.bitmapData.getPixel32(0, 0), 0xffff0000);
    assert.equal(logo.bitmapData.getPixel32(1, 0), 0xff00ff00);
    assert.equal(domain.getDefinition("Test_logo"), Root.Test_logo);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("resolves relative loader URLs against the host base URL", async () => {
  const swf = swfLibraryBytes();
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/libraries/testlib.swf")) {
      response.writeHead(200, { "content-type": "application/x-shockwave-flash" });
      response.end(swf);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/libraries/`;
  $setBaseUrl(base);
  assert.equal($getBaseUrl(), base);
  try {
    const Loader = $runtimeClass("flash.display.Loader");
    const URLRequest = $runtimeClass("flash.net.URLRequest");
    const loader = new Loader();
    const complete = new Promise<void>((resolve, reject) => {
      loader.contentLoaderInfo.addEventListener("complete", () => resolve());
      loader.contentLoaderInfo.addEventListener("ioError", (event: any) =>
        reject(new Error(event.text)),
      );
    });
    loader.load(new URLRequest("testlib.swf"));
    await complete;
    assert.equal(loader.contentLoaderInfo.url, `${base}testlib.swf`);
    assert.equal(loader.contentLoaderInfo.applicationDomain.hasDefinition("Test_logo"), true);
  } finally {
    $setBaseUrl("");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reports IOErrorEvent when a SWF library is unavailable", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const Loader = $runtimeClass("flash.display.Loader");
    const URLRequest = $runtimeClass("flash.net.URLRequest");
    const loader = new Loader();
    const failed = new Promise<string>((resolve) => {
      loader.contentLoaderInfo.addEventListener("ioError", (event: any) => resolve(event.text));
    });
    loader.load(new URLRequest(`http://127.0.0.1:${address.port}/missing.swf`));
    assert.match(await failed, /HTTP 404/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loads SWF bytes through Loader.loadBytes", async () => {
  const Loader = $runtimeClass("flash.display.Loader");
  const loader = new Loader();
  const info = loader.contentLoaderInfo;
  const complete = new Promise<void>((resolve, reject) => {
    info.addEventListener("complete", () => resolve());
    info.addEventListener("ioError", (event: any) => reject(new Error(event.text)));
  });
  loader.loadBytes(swfLibraryBytes(false));
  await complete;
  assert.equal(info.applicationDomain.hasDefinition("Test_logo"), true);
  assert.equal(info.applicationDomain.hasDefinition("testlib"), false);
  assert.ok(loader.content);
});

test("lowers delete on a member expression as a word operator", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      public class DeleteProp {
        private var map:Object = {};
        public function put(key:String):void {
          this.map[key] = 1;
        }
        public function remove(key:String):void {
          delete this.map[key];
        }
        public function has(key:String):Boolean {
          return key in this.map;
        }
      }
    }`,
    "DeleteProp.as",
    { runtimeSpecifier },
  );
  assert.deepEqual(result.diagnostics, []);
  const moduleSource = [...result.files].find(([file]) => file.endsWith("demo_DeleteProp.mjs"))?.[1];
  assert.match(moduleSource ?? "", /\$indexDelete\(this\.map, key\)/);
  assert.doesNotMatch(moduleSource ?? "", /deletethis/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-delete-"));
  try {
    for (const [file, source] of result.files) writeFileSync(join(directory, file), source);
    const { DeleteProp } = await import(
      pathToFileURL(join(directory, "demo_DeleteProp.mjs")).href
    );
    const instance = new DeleteProp();
    instance.put("key");
    assert.equal(instance.has("key"), true);
    instance.remove("key");
    assert.equal(instance.has("key"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps a super call nested in try as the only base construction", async () => {
  const fixture = readFileSync(new URL("../fixtures/TrySuper.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "TrySuper.as", { runtimeSpecifier });
  assert.deepEqual(result.diagnostics, []);
  const moduleSource = [...result.files].find(([file]) => file.endsWith("demo_TrySuper.mjs"))?.[1];
  assert.doesNotMatch(moduleSource ?? "", /\$super\(this, TrySuperBase, \[\]\)/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-trysuper-"));
  try {
    for (const [file, source] of result.files) writeFileSync(join(directory, file), source);
    const { TrySuper } = await import(
      pathToFileURL(join(directory, "demo_TrySuper.mjs")).href
    );
    assert.equal(new TrySuper("ok").value, "ok");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coerces method arguments to declared primitive parameter types", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      public class ParamCoerce {
        public function text(value:String):String {
          return value;
        }
        public function count(value:int):int {
          return value;
        }
      }
    }`,
    "ParamCoerce.as",
    { runtimeSpecifier },
  );
  assert.deepEqual(result.diagnostics, []);
  const moduleSource = [...result.files].find(([file]) => file.endsWith("demo_ParamCoerce.mjs"))?.[1];
  assert.match(moduleSource ?? "", /\$coerce\(value, "String"\)/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-paramcoerce-"));
  try {
    for (const [file, source] of result.files) writeFileSync(join(directory, file), source);
    const { ParamCoerce } = await import(
      pathToFileURL(join(directory, "demo_ParamCoerce.mjs")).href
    );
    const instance = new ParamCoerce();
    assert.equal(instance.text(5), "5");
    assert.equal(instance.text({ toString: () => "object" }), "object");
    assert.equal(instance.text(null), null);
    assert.equal(instance.count("7"), 7);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compiles Dictionary object-key bracket access through index helpers", async () => {
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(
    `package demo {
      public class DictKeys {
        public function put(dict:Object, key:Object, value:String):void {
          dict[key] = value;
        }
        public function read(dict:Object, key:Object):* {
          return dict[key];
        }
        public function remove(dict:Object, key:Object):void {
          delete dict[key];
        }
      }
    }`,
    "DictKeys.as",
    { runtimeSpecifier },
  );
  assert.deepEqual(result.diagnostics, []);
  const moduleSource = [...result.files].find(([file]) => file.endsWith("demo_DictKeys.mjs"))?.[1];
  assert.match(moduleSource ?? "", /\$indexSet\(/);
  assert.match(moduleSource ?? "", /\$indexDelete\(/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-dictkeys-"));
  try {
    for (const [file, source] of result.files) writeFileSync(join(directory, file), source);
    const { DictKeys } = await import(
      pathToFileURL(join(directory, "demo_DictKeys.mjs")).href
    );
    const Dictionary = $runtimeClass("flash.utils.Dictionary");
    const dictionary = new Dictionary();
    const key = function key() {};
    const instance = new DictKeys();

    instance.put(dictionary, key, "value");
    assert.equal(instance.read(dictionary, key), "value");
    assert.deepEqual($forIn(dictionary), [key]);
    instance.remove(dictionary, key);
    assert.deepEqual($forIn(dictionary), []);
    assert.equal(instance.read(dictionary, key), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds StyleSheet with style lookup and CSS parsing", () => {
  const StyleSheet = $runtimeClass("flash.text.StyleSheet");
  const sheet = new StyleSheet();
  sheet.setStyle(".title", { color: "#ff0000", fontSize: 18 });
  assert.deepEqual(sheet.getStyle(".title"), { color: "#ff0000", fontSize: 18 });
  assert.deepEqual(sheet.styleNames, [".title"]);
  sheet.parseCSS("a { color: #00ff00; } .x { fontWeight: bold }");
  assert.equal(sheet.getStyle("a").color, "#00ff00");
  assert.equal(sheet.getStyle(".x").fontWeight, "bold");
  sheet.clear();
  assert.deepEqual(sheet.styleNames, []);
});

test("binds Flash constant classes used during component initialization", () => {
  const GridFitType = $runtimeClass("flash.text.GridFitType");
  assert.equal(GridFitType.PIXEL, "pixel");
  assert.equal(GridFitType.NONE, "none");
  const BlendMode = $runtimeClass("flash.display.BlendMode");
  assert.equal(BlendMode.NORMAL, "normal");
  assert.equal(BlendMode.HARDLIGHT, "hardlight");
  const StageDisplayState = $runtimeClass("flash.display.StageDisplayState");
  assert.equal(StageDisplayState.FULL_SCREEN, "fullScreen");
  const FocusEvent = $runtimeClass("flash.events.FocusEvent");
  assert.equal(FocusEvent.FOCUS_IN, "focusIn");
  const KeyboardEvent = $runtimeClass("flash.events.KeyboardEvent");
  assert.equal(KeyboardEvent.KEY_DOWN, "keyDown");
});

test("binds ColorMatrixFilter with Flash's identity matrix and clone", () => {
  const ColorMatrixFilter = $runtimeClass("flash.filters.ColorMatrixFilter");
  const filter = new ColorMatrixFilter();
  assert.equal(filter.matrix.length, 20);
  assert.equal(filter.matrix[0], 1);
  assert.equal(filter.matrix[19], 0);
  assert.ok(filter instanceof $runtimeClass("flash.filters.BitmapFilter"));

  filter.matrix[0] = 0.5;
  const copy = filter.clone();
  assert.equal(copy.matrix[0], 0.5);
  copy.matrix[0] = 1;
  assert.equal(filter.matrix[0], 0.5);
});

test("registers embedded font classes and enumerates them", () => {
  const Font = $runtimeClass("flash.text.Font");
  const fontClass = Object.assign(function VolterFont() {}, {
    $fqcn: "fonts.VolterFont",
    $desc: {
      metadata: [
        {
          name: "Embed",
          args: [
            { name: "source", value: "Volter.ttf" },
            { name: "fontName", value: "Volter" },
            { name: "fontStyle", value: "italic" },
          ],
        },
      ],
    },
  });

  const font = Font.registerFont(fontClass);
  assert.equal(font.fontName, "Volter");
  assert.equal(font.fontType, "embedded");
  assert.equal(font.fontStyle, "italic");
  assert.equal(getQualifiedClassName(font), "fonts.VolterFont");
  assert.equal(Font.registerFont(fontClass), font);
  assert.deepEqual(Font.enumerateFonts(false), [font]);
  assert.deepEqual(Font.enumerateFonts(true), []);

  const copy = new Font(font);
  assert.equal(copy.fontName, "Volter");
  assert.equal(copy.fontStyle, "italic");
  assert.equal(getQualifiedClassName(copy), "fonts.VolterFont");
});

test("copies bitmap channels between BitmapData instances", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const Rectangle = $runtimeClass("flash.geom.Rectangle");
  const Point = $runtimeClass("flash.geom.Point");
  const source = new BitmapData(2, 1, true);
  source.setPixel32(0, 0, 0x80402010);
  source.setPixel32(1, 0, 0xff000000);
  const target = new BitmapData(2, 1, true);
  target.setPixel32(0, 0, 0x11223344);
  target.setPixel32(1, 0, 0x55667788);

  // ALPHA -> RED, leaving the other target channels untouched.
  target.copyChannel(source, new Rectangle(0, 0, 2, 1), new Point(0, 0), 8, 1);
  assert.equal(target.getPixel32(0, 0), 0x11803344);
  assert.equal(target.getPixel32(1, 0), 0x55ff7788);

  // RED -> ALPHA.
  target.copyChannel(source, new Rectangle(0, 0, 2, 1), new Point(0, 0), 1, 8);
  assert.equal(target.getPixel32(0, 0), 0x40803344);
  assert.equal(target.getPixel32(1, 0), 0x00ff7788);
});

test("draws BitmapData with Flash blend modes", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const draw = (mode: string) => {
    const target = new BitmapData(1, 1, true);
    target.setPixel32(0, 0, 0xffff8040);
    const source = new BitmapData(1, 1, true);
    source.setPixel32(0, 0, 0xff204080);
    target.draw(source, null, null, mode);
    return target.getPixel32(0, 0);
  };
  assert.equal(draw("normal"), 0xff204080);
  assert.equal(draw("darken"), 0xff204040);
  assert.equal(draw("multiply"), 0xff202020);
  assert.equal(draw("add"), 0xffffc0c0);
});

test("forwards host mouse events with stage coordinates", () => {
  const Stage = $runtimeClass("flash.display.Stage");
  const MouseEvent = $runtimeClass("flash.events.MouseEvent");
  const stage = new Stage();
  const seen: any[] = [];
  stage.addEventListener(MouseEvent.MOUSE_DOWN, (event: any) => {
    seen.push({ type: event.type, x: event.stageX, y: event.stageY, down: event.buttonDown });
  });
  $dispatchMouseEvent(stage, MouseEvent.MOUSE_DOWN, 12, 34, { buttonDown: true });
  assert.deepEqual(seen, [{ type: "mouseDown", x: 12, y: 34, down: true }]);
  assert.equal(stage.mouseX, 12);
  assert.equal(stage.mouseY, 34);
});

test("hit-tests bitmap pixels and overlapping bitmaps", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const Point = $runtimeClass("flash.geom.Point");
  const bitmap = new BitmapData(2, 1, true, 0);
  bitmap.setPixel32(0, 0, 0xffff0000);
  // Flash's threshold is inclusive; 0 accepts a fully transparent pixel, so use 1 for shape tests.
  assert.equal(bitmap.hitTest(new Point(0, 0), 1, new Point(0, 0)), true);
  assert.equal(bitmap.hitTest(new Point(0, 0), 1, new Point(1, 0)), false);
  assert.equal(bitmap.hitTest(new Point(0, 0), 0, new Point(1, 0)), true);

  const other = new BitmapData(1, 1, true, 0xff00ff00);
  assert.equal(bitmap.hitTest(new Point(0, 0), 1, other, new Point(0, 0)), true);
  assert.equal(bitmap.hitTest(new Point(0, 0), 1, other, new Point(1, 0)), false);
  assert.equal(bitmap.hitTest(new Point(0, 0), 255, other, new Point(0, 0)), true);
});

test("copyPixels composites with mergeAlpha and an alpha bitmap", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const Rectangle = $runtimeClass("flash.geom.Rectangle");
  const Point = $runtimeClass("flash.geom.Point");

  const target = new BitmapData(2, 1, true, 0xff204060);
  const source = new BitmapData(2, 1, true, 0);
  source.setPixel32(0, 0, 0xffff0000);
  source.setPixel32(1, 0, 0x0000ff00);
  target.copyPixels(source, new Rectangle(0, 0, 2, 1), new Point(0, 0), null, null, true);
  assert.equal(target.getPixel32(0, 0), 0xffff0000, "opaque pixels replace");
  assert.equal(target.getPixel32(1, 0), 0xff204060, "transparent pixels keep the destination");

  // Half-alpha red over opaque blue.
  const over = new BitmapData(1, 1, true, 0xff0000ff);
  const half = new BitmapData(1, 1, true, 0x80ff0000);
  over.copyPixels(half, half.rect, new Point(0, 0), null, null, true);
  assert.equal(over.getPixel32(0, 0), 0xff80007f);

  // An alpha bitmap scales the copied alpha.
  const masked = new BitmapData(1, 1, true, 0);
  const opaque = new BitmapData(1, 1, true, 0xffff0000);
  const mask = new BitmapData(1, 1, true, 0x80000000);
  masked.copyPixels(opaque, opaque.rect, new Point(0, 0), mask, new Point(0, 0), false);
  assert.equal(masked.getPixel32(0, 0), 0x80ff0000);
});

test("loads embedded font bytes into the host font set", () => {
  const directory = mkdtempSync(join(tmpdir(), "as3js-font-"));
  mkdirSync(join(directory, "fonts"));
  writeFileSync(join(directory, "fonts", "Test.ttf"), Buffer.from([0x00, 0x01, 0x00, 0x00]));
  const archive = createPopFromDirectory(directory, { bundle: "app" });
  const manager = new AssetManager();
  manager.addBundle("app", PopArchive.fromBytes(archive.bytes));
  $setAssetManager(manager);
  const added: any[] = [];
  const globalObject = globalThis as any;
  const originalDocument = globalObject.document;
  const originalFontFace = globalObject.FontFace;
  globalObject.document = { fonts: { add: (face: any) => added.push(face) } };
  globalObject.FontFace = class {
    family: string;
    descriptors: any;
    loaded = false;
    constructor(family: string, _source: ArrayBuffer, descriptors: any) {
      this.family = family;
      this.descriptors = descriptors;
    }
    load() {
      this.loaded = true;
      return Promise.resolve(this);
    }
  };
  try {
    const fontClass = Object.assign(function TestFont() {}, {
      $fqcn: "fonts.TestFont",
      $desc: {
        metadata: [{
          name: "Embed",
          args: [
            { name: "source", value: "fonts/Test.ttf" },
            { name: "fontFamily", value: "Test Face" },
            { name: "fontWeight", value: "bold" },
          ],
        }],
      },
    });
    const font = $runtimeClass("flash.text.Font").registerFont(fontClass);
    assert.equal(font.fontName, "Test Face");
    assert.equal(added.length, 1);
    assert.equal(added[0].family, "Test Face");
    assert.deepEqual(added[0].descriptors, { weight: "bold" });
    assert.equal(added[0].loaded, true);
  } finally {
    $setAssetManager(null);
    globalObject.document = originalDocument;
    globalObject.FontFace = originalFontFace;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds private method references to the declaring class", async () => {
  const fixture = readFileSync(new URL("../fixtures/PrivateShadow.as", import.meta.url), "utf8");
  const runtimeSpecifier = pathToFileURL(
    join(process.cwd(), "packages/runtime/src/index.ts"),
  ).href;
  const result = compileSource(fixture, "PrivateShadow.as", { runtimeSpecifier });

  assert.deepEqual(result.diagnostics, []);
  const emitted = result.files.get("demo_PrivateShadowBase.mjs")!;
  // AS3 private methods are not virtual, so the base reference must name its own class.
  assert.match(emitted, /\$bindMethod\(this, "tick", "demo\.PrivateShadowBase"\)/);

  const directory = mkdtempSync(join(tmpdir(), "as3js-private-shadow-"));
  try {
    for (const [file, source] of result.files) {
      writeFileSync(join(directory, file), source);
    }
    const { PrivateShadow } = await import(pathToFileURL(join(directory, "demo_PrivateShadow.mjs")).href);
    // The subclass declares its own `tick`; both base references must still reach the base.
    assert.equal(new PrivateShadow().run(), "base;base;");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exposes DisplayObject.transform as a live matrix and color transform", () => {
  const Sprite = $runtimeClass("flash.display.Sprite");
  const ColorTransform = $runtimeClass("flash.geom.ColorTransform");
  const Matrix = $runtimeClass("flash.geom.Matrix");

  const sprite = new Sprite();
  const transform = sprite.transform;
  assert.equal(sprite.transform, transform, "one Transform per display object");

  const tint = new ColorTransform(1, 1, 1, 0.5);
  transform.colorTransform = tint;
  assert.equal(transform.colorTransform, tint);

  transform.matrix = new Matrix(2, 0, 0, 4, 10, 20);
  assert.deepEqual([sprite.x, sprite.y, sprite.scaleX, sprite.scaleY], [10, 20, 2, 4]);
  assert.deepEqual(
    [transform.matrix.a, transform.matrix.d, transform.matrix.tx],
    [2, 4, 10],
  );
  assert.equal(transform.concatenatedMatrix.a, 2);
});

test("applies a ColorMatrixFilter through BitmapData.applyFilter", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const ColorMatrixFilter = $runtimeClass("flash.filters.ColorMatrixFilter");

  const data = new BitmapData(2, 1, true, 0xff804020);
  const greyscale = new ColorMatrixFilter();
  greyscale.matrix = [
    0.3, 0.59, 0.11, 0, 0,
    0.3, 0.59, 0.11, 0, 0,
    0.3, 0.59, 0.11, 0, 0,
    0, 0, 0, 1, 0,
  ];
  // Filtering in place must read the source region before writing it back.
  data.applyFilter(data, data.rect, { x: 0, y: 0 }, greyscale);
  // 0.3*128 + 0.59*64 + 0.11*32 = 79.68 -> 80, alpha untouched.
  assert.equal(data.getPixel32(0, 0), 0xff505050);
  assert.equal(data.getPixel32(1, 0), 0xff505050);
  assert.throws(
    () => data.applyFilter(data, data.rect, { x: 0, y: 0 }, { blurX: 2 }),
    /filters of type unknown are not implemented/,
  );
});

test("exposes DisplayObject.colorTransform as one live object", () => {
  const Sprite = $runtimeClass("flash.display.Sprite");
  const ColorTransform = $runtimeClass("flash.geom.ColorTransform");

  const sprite = new Sprite();
  const transform = sprite.colorTransform;
  assert.equal(transform.alphaMultiplier, 1);
  assert.equal(sprite.colorTransform, transform, "one ColorTransform per display object");

  const replacement = new ColorTransform(1, 1, 1, 0.25);
  sprite.colorTransform = replacement;
  assert.equal(sprite.colorTransform, replacement);
});

test("blurs BitmapData with a box blur that approaches Flash's Gaussian", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const BlurFilter = $runtimeClass("flash.filters.BlurFilter");

  const data = new BitmapData(3, 1, true, 0x00000000);
  data.setPixel32(1, 0, 0xffffffff);
  data.applyFilter(data, data.rect, { x: 0, y: 0 }, new BlurFilter(3, 1, 1));
  // 255 spread over three pixels is 85 each, straight-alpha white.
  assert.equal(data.getPixel32(0, 0), 0x55ffffff);
  assert.equal(data.getPixel32(1, 0), 0x55ffffff);
  assert.equal(data.getPixel32(2, 0), 0x55ffffff);
});

test("spreads a GlowFilter behind the shape in its colour", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const GlowFilter = $runtimeClass("flash.filters.GlowFilter");

  const data = new BitmapData(5, 5, true, 0x00000000);
  data.setPixel32(2, 2, 0xffffffff);
  data.applyFilter(data, data.rect, { x: 0, y: 0 }, new GlowFilter(0xff0000, 1, 6, 6, 1, 1));
  assert.equal(data.getPixel32(2, 2), 0xffffffff, "the shape stays on top");
  const glow = data.getPixel32(1, 1);
  assert.ok((glow >>> 24) > 0, "the glow reaches neighbouring pixels");
  assert.equal((glow >>> 16) & 0xff, 0xff, "the glow is drawn in its colour");
  assert.equal(glow & 0xff, 0, "with no other channel");
});

test("convolves BitmapData with clamping at the edges", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const ConvolutionFilter = $runtimeClass("flash.filters.ConvolutionFilter");

  const data = new BitmapData(2, 1, true, 0xff804020);
  data.setPixel32(1, 0, 0xff102030);
  const identity = new ConvolutionFilter(3, 3, [0, 0, 0, 0, 1, 0, 0, 0, 0], 1, 0, true, true);
  data.applyFilter(data, data.rect, { x: 0, y: 0 }, identity);
  assert.equal(data.getPixel32(0, 0), 0xff804020);
  assert.equal(data.getPixel32(1, 0), 0xff102030);

  // Every neighbour clamps to the pixel itself, so the average stays white.
  const white = new BitmapData(1, 1, true, 0xffffffff);
  const average = new ConvolutionFilter(3, 3, [0, 1, 0, 1, 0, 1, 0, 1, 0], 4, 0, true, true);
  white.applyFilter(white, white.rect, { x: 0, y: 0 }, average);
  assert.equal(white.getPixel32(0, 0), 0xffffffff);
});

test("transforms a BitmapData region through BitmapData.colorTransform", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const ColorTransform = $runtimeClass("flash.geom.ColorTransform");

  const data = new BitmapData(2, 1, false, 0xff804020);
  data.colorTransform({ x: 0, y: 0, width: 1, height: 1 }, new ColorTransform(0.5, 0.5, 0.5, 1));
  assert.equal(data.getPixel32(0, 0), 0xff402010);
  assert.equal(data.getPixel32(1, 0), 0xff804020, "only the rect is transformed");
});

test("sorts with Flash's array intrinsics", () => {
  assert.equal((Array as any).NUMERIC, 16);
  assert.equal((Array as any).DESCENDING, 2);
  assert.equal((Array as any).CASEINSENSITIVE, 1);

  const list: any[] = [
    { name: "c", useCount: 10 },
    { name: "B", useCount: 2 },
    { name: "a", useCount: 1 },
  ];
  (list as any).sortOn("useCount", (Array as any).DESCENDING | (Array as any).NUMERIC);
  assert.deepEqual(list.map((entry) => entry.name), ["c", "B", "a"]);
  (list as any).sortOn("name", (Array as any).CASEINSENSITIVE);
  assert.deepEqual(list.map((entry) => entry.name), ["a", "B", "c"]);

  // A field name list pairs each name with its own flags, as the friend list does.
  const friends: any[] = [
    { name: "zoe", pocketHabboUser: 1 },
    { name: "Amy", pocketHabboUser: 1 },
    { name: "bob", pocketHabboUser: 2 },
  ];
  (friends as any).sortOn(
    ["pocketHabboUser", "name"],
    [(Array as any).NUMERIC | (Array as any).DESCENDING, (Array as any).CASEINSENSITIVE],
  );
  assert.deepEqual(friends.map((entry) => entry.name), ["bob", "Amy", "zoe"]);

  const numbers = [10, 9, 1];
  numbers.sort((Array as any).NUMERIC);
  assert.deepEqual(numbers, [1, 9, 10]);
});

test("displaces BitmapData through a displacement map", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const DisplacementMapFilter = $runtimeClass("flash.filters.DisplacementMapFilter");

  const data = new BitmapData(2, 1, true, 0xff804020);
  data.setPixel32(1, 0, 0xff102030);
  const map = new BitmapData(2, 1, true, 0x80808080);
  data.applyFilter(data, data.rect, { x: 0, y: 0 }, new DisplacementMapFilter(map, { x: 0, y: 0 }, 1, 2, 8, 8, "wrap"));
  // Mid-grey channels mean no offset, so the pixels stay where they are.
  assert.equal(data.getPixel32(0, 0), 0xff804020);
  assert.equal(data.getPixel32(1, 0), 0xff102030);
});

test("locks and unlocks BitmapData without disturbing its pixels", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");

  const data = new BitmapData(1, 1, true, 0xff102030);
  data.lock();
  data.setPixel32(0, 0, 0xff405060);
  data.unlock();
  assert.equal(data.getPixel32(0, 0), 0xff405060);
  data.unlock();
});

test("draws a BitmapData through a matrix, color transform and clip rect", () => {
  const BitmapData = $runtimeClass("flash.display.BitmapData");
  const ColorTransform = $runtimeClass("flash.geom.ColorTransform");
  const Matrix = $runtimeClass("flash.geom.Matrix");
  const Rectangle = $runtimeClass("flash.geom.Rectangle");

  const source = new BitmapData(2, 1, true, 0x00000000);
  source.setPixel32(0, 0, 0xffff0000);
  source.setPixel32(1, 0, 0x00ff0000); // transparent pixels leave the target alone

  // Half-alpha red over opaque blue: 0x80 red, 0x80 blue, opaque.
  const target = new BitmapData(3, 1, true, 0xff0000ff);
  target.draw(source, new Matrix(1, 0, 0, 1, 1, 0), new ColorTransform(1, 1, 1, 0.5));
  assert.equal(target.getPixel32(0, 0), 0xff0000ff, "translation leaves x=0 untouched");
  assert.equal(target.getPixel32(1, 0), 0xff800080);
  assert.equal(target.getPixel32(2, 0), 0xff0000ff, "transparent source pixel is not composited");

  // A clip rect restricts which target pixels the draw may touch.
  const clipped = new BitmapData(3, 1, true, 0xff0000ff);
  clipped.draw(
    source,
    new Matrix(1, 0, 0, 1, 1, 0),
    new ColorTransform(1, 1, 1, 0.5),
    null,
    new Rectangle(0, 0, 1, 1),
  );
  assert.equal(clipped.getPixel32(1, 0), 0xff0000ff);

  clipped.draw(source, new Matrix(), null, "add");
  assert.equal(clipped.getPixel32(0, 0), 0xffff00ff, "add blends red over blue");
});
