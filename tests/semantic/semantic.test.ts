import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSource } from "../../packages/compiler/src/parser/parser.ts";
import {
  analyzeProject,
  analyzeSource,
  type SourceUnit,
} from "../../packages/compiler/src/semantic/analyzer.ts";
import type { ClassDeclaration } from "../../packages/compiler/src/ast.ts";
import { DEFAULT_RUNTIME_MANIFEST } from "../../packages/compiler/src/semantic/runtime-manifest.ts";

function unit(file: string, source: string): SourceUnit {
  const parsed = parseSource(source, file);
  return { file, program: parsed.program, diagnostics: parsed.diagnostics };
}

function project(files: Record<string, string>) {
  return analyzeProject(
    Object.entries(files).map(([file, source]) => unit(file, source)),
  );
}

function errors(result: ReturnType<typeof analyzeSource>) {
  return result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}

function codes(result: ReturnType<typeof analyzeSource>) {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

const SHORT_NAME_COLLISIONS: Record<string, string[]> = {
  ActionDefinition: ["com.sulake.habbo.avatar.actions.ActionDefinition", "com.sulake.habbo.communication.messages.incoming.userdefinedroomevents.ActionDefinition"],
  ActionType: ["com.sulake.habbo.avatar.actions.ActionType", "com.sulake.habbo.roomevents.userdefinedroomevents.actiontypes.ActionType"],
  AlertView: ["com.sulake.habbo.friendlist.AlertView", "com.sulake.habbo.navigator.AlertView"],
  Animation: ["com.sulake.habbo.avatar.animation.Animation", "com.sulake.habbo.quest.Animation"],
  AnimationData: ["com.sulake.habbo.avatar.structure.AnimationData", "com.sulake.habbo.help.guidehelp.AnimationData", "com.sulake.habbo.room.object.visualization.data.AnimationData"],
  AnimationFrame: ["com.sulake.habbo.avatar.structure.animation.AnimationFrame", "com.sulake.habbo.room.object.visualization.data.AnimationFrame"],
  AnimationLayerData: ["com.sulake.habbo.avatar.animation.AnimationLayerData", "com.sulake.habbo.room.object.visualization.data.AnimationLayerData"],
  AvatarImageWidget: ["com.sulake.habbo.friendbar.landingview.widget.AvatarImageWidget", "com.sulake.habbo.window.widgets.AvatarImageWidget"],
  ChatBubbleFactory: ["com.sulake.habbo.freeflowchat.viewer.ChatBubbleFactory", "com.sulake.habbo.ui.widget.roomchat.style.ChatBubbleFactory"],
  ChatEventHandler: ["com.sulake.habbo.freeflowchat.data.ChatEventHandler", "com.sulake.habbo.help.cfh.registry.chat.ChatEventHandler"],
  CloseButtonConfig: ["org.openvideoads.regions.config.CloseButtonConfig", "org.openvideoads.vast.config.groupings.CloseButtonConfig"],
  EffectsModel: ["com.sulake.habbo.avatar.effects.EffectsModel", "com.sulake.habbo.inventory.effects.EffectsModel"],
  EffectsView: ["com.sulake.habbo.avatar.effects.EffectsView", "com.sulake.habbo.inventory.effects.EffectsView"],
  FriendRequest: ["com.sulake.habbo.friendbar.data.FriendRequest", "com.sulake.habbo.friendlist.domain.FriendRequest"],
  FurnitureData: ["com.sulake.habbo.room.utils.FurnitureData", "com.sulake.habbo.session.furniture.FurnitureData"],
  IncomingMessages: ["com.sulake.habbo.game.IncomingMessages", "com.sulake.habbo.inventory.IncomingMessages", "com.sulake.habbo.navigator.IncomingMessages", "com.sulake.habbo.notifications.IncomingMessages", "com.sulake.habbo.quest.IncomingMessages", "com.sulake.habbo.roomevents.IncomingMessages", "snowwar.IncomingMessages"],
  MeMenuChatSettingsView: ["com.sulake.habbo.toolbar.memenu.chatsettings.MeMenuChatSettingsView", "com.sulake.habbo.ui.widget.memenu.chatsettings.MeMenuChatSettingsView"],
  MeMenuSettingsMenuView: ["com.sulake.habbo.toolbar.memenu.MeMenuSettingsMenuView", "com.sulake.habbo.ui.widget.memenu.MeMenuSettingsMenuView"],
  MeMenuSoundSettingsItem: ["com.sulake.habbo.toolbar.memenu.soundsettings.MeMenuSoundSettingsItem", "com.sulake.habbo.ui.widget.memenu.soundsettings.MeMenuSoundSettingsItem"],
  MeMenuSoundSettingsSlider: ["com.sulake.habbo.toolbar.memenu.soundsettings.MeMenuSoundSettingsSlider", "com.sulake.habbo.ui.widget.memenu.soundsettings.MeMenuSoundSettingsSlider"],
  MeMenuSoundSettingsView: ["com.sulake.habbo.toolbar.memenu.soundsettings.MeMenuSoundSettingsView", "com.sulake.habbo.ui.widget.memenu.soundsettings.MeMenuSoundSettingsView"],
  NewMessageEvent: ["com.sulake.habbo.friendbar.events.NewMessageEvent", "com.sulake.habbo.messenger.events.NewMessageEvent"],
  PetFigureData: ["com.sulake.habbo.avatar.pets.PetFigureData", "com.sulake.habbo.communication.messages.parser.inventory.pets.PetFigureData"],
  Purse: ["com.sulake.habbo.catalog.purse.Purse", "com.sulake.habbo.inventory.purse.Purse"],
  RegionController: ["com.sulake.core.window.components.RegionController", "org.openvideoads.regions.RegionController"],
  RoomData: ["com.sulake.habbo.communication.messages.incoming.moderation.RoomData", "com.sulake.habbo.room.utils.RoomData"],
  SearchView: ["com.sulake.habbo.friendlist.SearchView", "com.sulake.habbo.navigator.view.search.SearchView"],
  StringUtils: ["com.apdevblog.utils.StringUtils", "org.openvideoads.util.StringUtils"],
  Tab: ["com.sulake.habbo.friendbar.view.tabs.Tab", "com.sulake.habbo.navigator.domain.Tab"],
  ToolbarHoverCtrl: ["com.sulake.habbo.navigator.roomsettings.ToolbarHoverCtrl", "com.sulake.habbo.navigator.toolbar.ToolbarHoverCtrl"],
  TopViewSelector: ["com.sulake.habbo.catalog.TopViewSelector", "com.sulake.habbo.navigator.view.TopViewSelector"],
  Util: ["com.sulake.habbo.friendlist.Util", "com.sulake.habbo.navigator.Util", "com.sulake.habbo.roomevents.Util"],
};

test("builds a project graph and resolves explicit imports", () => {
  const result = project({
    "A.as": "package p { import q.B; public class A extends B { public var b:B; } }",
    "B.as": "package q { public class B {} }",
  });

  assert.deepEqual(errors(result), []);
  const a = result.graph.types.find((type) => type.fqcn === "p.A");
  const b = result.graph.types.find((type) => type.fqcn === "q.B");
  assert.ok(a);
  assert.ok(b);
  assert.equal(a.base, "q.B");
  assert.equal(a.members[0]?.type, "q.B");
  assert.equal(result.graph.version, 1);
  assert.doesNotThrow(() => JSON.stringify(result.graph));
});

test("resolves same-package and wildcard imports", () => {
  const result = project({
    "A.as": "package p { import q.*; public class A { public var b:B; } }",
    "B.as": "package q { public class B {} }",
    "C.as": "package p { public class C extends A {} }",
  });

  assert.deepEqual(errors(result), []);
  assert.equal(
    result.graph.types.find((type) => type.fqcn === "p.C")?.base,
    "p.A",
  );
});

test("resolves all 32 corpus short-name collisions by explicit FQCN", () => {
  const files: Record<string, string> = {};
  let typeCount = 0;
  const entries = Object.entries(SHORT_NAME_COLLISIONS);
  entries.forEach(([name, fqcns], index) => {
    for (const fqcn of fqcns) {
      const packageName = fqcn.slice(0, fqcn.lastIndexOf("."));
      files[`${fqcn.replaceAll(".", "_")}.as`] =
        `package ${packageName} { public class ${name} {} }`;
      typeCount += 1;
    }
    const selected = fqcns[0]!;
    files[`Uses${index}.as`] =
      `package collisiontest { import ${selected}; public class Uses${index} { public var value:${name}; } }`;
  });

  const result = project(files);
  assert.equal(entries.length, 32);
  assert.equal(typeCount, 71);
  assert.deepEqual(errors(result), []);
  entries.forEach(([, fqcns], index) => {
    const use = result.graph.types.find((type) => type.fqcn === `collisiontest.Uses${index}`);
    assert.equal(use?.members[0]?.type, fqcns[0], `Uses${index}`);
  });
});

test("reports duplicate FQCNs and unresolved types", () => {
  const duplicate = project({
    "One.as": "package p { public class A {} }",
    "Two.as": "package p { public class A {} }",
  });
  assert.ok(codes(duplicate).includes("SEM001"));

  const missing = analyzeSource(
    "package p { public class A extends Missing {} }",
    "Missing.as",
  );
  assert.ok(codes(missing).includes("SEM002"));
  assert.match(missing.diagnostics.find((d) => d.code === "SEM002")!.message, /Missing/);
});

test("checks interface completeness, accessors, and missing implementations", () => {
  const valid = analyzeSource(
    `package p {
      public interface I {
        function get value():int;
        function set value(v:int):void;
        function run():void;
      }
      public class C implements I {
        private var _value:int;
        public function get value():int { return _value; }
        public function set value(v:int):void { _value = v; }
        public function run():void {}
      }
    }`,
    "Interface.as",
  );
  assert.deepEqual(errors(valid), []);

  const missing = analyzeSource(
    `package p {
      public interface I { function run():void; }
      public class C implements I {}
    }`,
    "MissingInterface.as",
  );
  assert.ok(codes(missing).includes("SEM007"));
});

test("checks override, final, static, and access rules", () => {
  const missingOverride = analyzeSource(
    `package p {
      public class Base { public function f():void {} }
      public class C extends Base { public function f():void {} }
    }`,
    "Override.as",
  );
  assert.ok(codes(missingOverride).includes("SEM008"));

  const validOverride = analyzeSource(
    `package p {
      public class Base { public function f():void {} }
      public class C extends Base { override public function f():void {} }
    }`,
    "OverrideValid.as",
  );
  assert.deepEqual(errors(validOverride), []);

  const finalBase = analyzeSource(
    `package p {
      public final class Base {}
      public class C extends Base {}
    }`,
    "FinalBase.as",
  );
  assert.ok(codes(finalBase).includes("SEM010"));

  const finalMember = analyzeSource(
    `package p {
      public class Base { public final function f():void {} }
      public class C extends Base { override public function f():void {} }
    }`,
    "FinalMember.as",
  );
  assert.ok(codes(finalMember).includes("SEM011"));

  const access = analyzeSource(
    `package p {
      public class A { private var secret:int; }
      public class B { public function read(a:A):void { a.secret = 1; } }
    }`,
    "Access.as",
  );
  assert.ok(codes(access).includes("SEM013"));

  const staticMethod = analyzeSource(
    `package p {
      public class Base { public static function make():String { return "base"; } }
      public class C extends Base { public static function make():String { return "child"; } }
    }`,
    "StaticMethod.as",
  );
  assert.deepEqual(errors(staticMethod), []);
});

test("checks assignments and function-scoped declarations", () => {
  const mismatch = analyzeSource(
    `package p {
      public class A {}
      public class B {}
      public class C { public function f():void { var a:A = new B(); } }
    }`,
    "Mismatch.as",
  );
  assert.ok(codes(mismatch).includes("SEM015"));

  const scoped = analyzeSource(
    `package p {
      public class A {
        private static const N:int = 1;
        public function f():void {
          var n:int = N;
          for (var i:int = 0; i < 1; i++) {}
          i = 2;
          var cb:Function = this.f;
        }
      }
    }`,
    "Scope.as",
  );
  assert.deepEqual(errors(scoped), []);
});

test("detects class-initialization cycles and serializes them", () => {
  const result = analyzeSource(
    `package p {
      public class A { public static const SELF:A = new (A)(); }
      public class B { public static const A_REF:A = new A(); }
    }`,
    "ClassInit.as",
  );

  assert.ok(codes(result).includes("SEM021"));
  assert.equal(result.diagnostics.find((diagnostic) => diagnostic.code === "SEM021")?.severity, "warning");
  assert.deepEqual(result.graph.classInit.edges, [
    { from: "p.A", to: "p.A" },
    { from: "p.B", to: "p.A" },
  ]);
  assert.deepEqual(result.graph.classInit.cycles, [["p.A"]]);
});

test("supports with statements and keeps external runtime bases opaque", () => {
  const withStatement = analyzeSource(
    `package p { public class A { public function f():void { with (x) { y = 1; } } } }`,
    "With.as",
  );
  assert.ok(!codes(withStatement).includes("SEM018"));

  const external = analyzeSource(
    `package p {
      import flash.display.Sprite;
      public class A extends Sprite {
        public function f():void {
          x = 1;
          addChild(null);
        }
      }
    }`,
    "External.as",
  );
  assert.deepEqual(errors(external), []);
});

test("uses explicit external member signatures", () => {
  const result = analyzeSource(
    `package p {
      import flash.net.URLLoader;
      import flash.net.URLRequest;
      import flash.utils.ByteArray;
      public class A {
        public function f(loader:URLLoader, request:URLRequest):ByteArray {
          request.url = "https://example.invalid/data";
          var data:ByteArray = loader.data;
          return data;
        }
      }
    }`,
    "ExternalMembers.as",
  );
  assert.deepEqual(errors(result), []);
});

test("types the expanded external signatures", () => {
  const result = analyzeSource(
    `package p {
      import flash.events.Event;
      import flash.events.MouseEvent;
      import flash.net.URLLoader;
      import flash.geom.ColorTransform;
      public class A {
        public function f(event:MouseEvent, loader:URLLoader):String {
          var x:Number = event.localX;
          var frame:String = Event.ENTER_FRAME;
          var loaded:uint = loader.bytesLoaded;
          var transform:ColorTransform = new ColorTransform();
          transform.color = 0xFFFFFF;
          return frame + ":" + loaded + ":" + x;
        }
      }
    }`,
    "ExternalSignatures.as",
  );
  assert.deepEqual(errors(result), []);

  const manifest = DEFAULT_RUNTIME_MANIFEST.types.find((type) => type.fqcn === "flash.events.MouseEvent");
  const localX = manifest?.members?.find((member) => member.name === "localX");
  assert.equal(localX?.type, "Number");
  assert.equal(localX?.readonly, true);

  const event = DEFAULT_RUNTIME_MANIFEST.types.find((type) => type.fqcn === "flash.events.Event");
  const enterFrame = event?.members?.find((member) => member.name === "ENTER_FRAME");
  assert.equal(enterFrame?.type, "String");
  assert.equal(enterFrame?.static, true);
});

test("keeps Phase 2 fixtures semantically clean", () => {
  for (const fixture of ["Hello", "Features", "E4X", "Types", "Advanced"]) {
    const source = readFileSync(new URL(`../fixtures/${fixture}.as`, import.meta.url), "utf8");
    const result = analyzeSource(source, `${fixture}.as`);
    assert.deepEqual(errors(result), [], fixture);
  }
});

test("keeps class declarations found after a package block", () => {
  const source = readFileSync("tests/fixtures/Advanced.as", "utf8");
  const result = parseSource(source, "Advanced.as");
  const declaration = result.program.declarations[1] as ClassDeclaration;
  assert.equal(declaration.kind, "ClassDeclaration");
  assert.equal(declaration.name, "Advanced");
  assert.equal(declaration.members[0]?.kind, "ClassInitializer");
});
