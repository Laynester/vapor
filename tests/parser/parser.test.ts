import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSource } from "../../packages/compiler/src/parser/parser.ts";
import { toSnapshot } from "../../packages/compiler/src/ast.ts";
import type {
  ClassDeclaration,
  ForInStatement,
  MethodDeclaration,
  SwitchStatement,
  TryStatement,
} from "../../packages/compiler/src/ast.ts";

function parseFixture(name: string) {
  const source = readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
  return parseSource(source, name);
}

test("parses the basic class fixture without diagnostics", () => {
  const result = parseFixture("Hello.as");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.program.packageName, "demo");
  assert.equal(result.program.imports[0]!.name, "flash.display.MovieClip");

  const cls = result.program.declarations[0] as ClassDeclaration;
  assert.equal(cls.kind, "ClassDeclaration");
  assert.equal(cls.name, "Hello");
  assert.equal(cls.extends?.kind, "NamedType");
  assert.equal(cls.members.length, 3);
  const ctor = cls.members[1] as MethodDeclaration;
  assert.equal(ctor.isConstructor, true);
  assert.equal(ctor.name, "Hello");
  assert.equal(ctor.body?.body[0]?.kind, "ExpressionStatement");
});

test("parses metadata, accessors, interfaces, vectors and loop forms", () => {
  const result = parseFixture("Features.as");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.program.declarations.length, 2);
  assert.equal(result.program.declarations[0]!.kind, "InterfaceDeclaration");

  const cls = result.program.declarations[1] as ClassDeclaration;
  assert.equal(cls.members.length, 9);
  assert.equal(cls.members[0]!.kind, "FieldDeclaration");
  const image = cls.members[0] as any;
  assert.equal(image.metadata[0].name, "Embed");
  assert.equal(image.metadata[0].args[0].name, "source");

  const compute = cls.members.find((m) => m.kind === "MethodDeclaration" && m.name === "compute") as MethodDeclaration;
  assert.equal(compute.params[0]!.type?.kind, "VectorType");
  assert.equal(compute.params[1]!.rest, true);
  const forEach = compute.body!.body.find((s) => s.kind === "ForInStatement") as ForInStatement;
  assert.equal(forEach.each, true);
  assert.equal(forEach.body.kind, "BlockStatement");

  const classify = cls.members.find((m) => m.kind === "MethodDeclaration" && m.name === "classify") as MethodDeclaration;
  const sw = classify.body!.body[0] as SwitchStatement;
  assert.equal(sw.cases.length, 4);
  assert.equal(sw.cases[0]!.test?.kind, "Literal");

  const guard = cls.members.find((m) => m.kind === "MethodDeclaration" && m.name === "guard") as MethodDeclaration;
  const tryStmt = guard.body!.body[0] as TryStatement;
  assert.equal(tryStmt.catches.length, 1);
  assert.ok(tryStmt.finalizer);
});

test("parses E4X literals, attributes, descendants, filters and qualifiers", () => {
  const result = parseFixture("E4X.as");
  assert.deepEqual(result.diagnostics, []);
  const cls = result.program.declarations[0] as ClassDeclaration;
  const method = cls.members[0] as MethodDeclaration;
  const statements = method.body!.body;
  assert.equal(statements.length, 8);

  const declarations = statements.map((s: any) => s.declarations?.[0]).filter(Boolean);
  assert.equal(declarations[0]!.initializer.kind, "Literal");
  assert.equal(declarations[0]!.initializer.literalKind, "xml");

  const firstId = declarations[1]!.initializer;
  assert.equal(firstId.kind, "MemberExpression");
  assert.equal(firstId.access, "attribute");

  const all = declarations[2]!.initializer;
  assert.equal(all.kind, "MemberExpression");
  assert.equal(all.access, "descendant");

  const filtered = declarations[3]!.initializer;
  assert.equal(filtered.kind, "XmlFilterExpression");
  assert.equal(filtered.predicate.kind, "BinaryExpression");

  const qualified = declarations[5]!.initializer;
  assert.equal(qualified.kind, "MemberExpression");
  assert.equal(qualified.access, "qualified");
  assert.equal(qualified.namespace, "ns");
});

test("parses nested Vector types and splits >> tokens", () => {
  const result = parseFixture("Types.as");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.program.declarations[0]!.kind, "NamespaceDeclaration");
  const cls = result.program.declarations[1] as ClassDeclaration;
  const field = cls.members[0] as any;
  assert.equal(field.type.kind, "VectorType");
  assert.equal(field.type.element.kind, "VectorType");
  assert.equal(field.type.element.element.name, "int");

  const make = cls.members.find((m) => m.kind === "MethodDeclaration" && m.name === "make") as MethodDeclaration;
  const value = (make.body!.body[0] as any).declarations[0];
  assert.equal(value.type.kind, "VectorType");
  assert.equal(value.initializer.kind, "NewExpression");
  assert.equal(value.initializer.target.kind, "VectorTypeExpression");
});

test("snapshots a small AST without spans", () => {
  const result = parseSource(
    "package { public class A { public var x:int = 1; } }",
    "snapshot.as",
  );
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(toSnapshot(result.program), {
    kind: "Program",
    packageName: null,
    imports: [],
    declarations: [
      {
        kind: "ClassDeclaration",
        name: "A",
        modifiers: ["public"],
        metadata: [],
        extends: null,
        implements: [],
        members: [
          {
            kind: "FieldDeclaration",
            name: "x",
            isConst: false,
            type: { kind: "NamedType", name: "int", namespace: null },
            initializer: {
              kind: "Literal",
              literalKind: "number",
              raw: "1",
              value: 1,
            },
            modifiers: ["public"],
            metadata: [],
          },
        ],
      },
    ],
  });
});

test("drops quotes from quoted object-literal keys", () => {
  const result = parseSource(
    'package demo { public class Keys { public static function run():Object { return {"type": "complete"}; } } }',
    "Keys.as",
  );
  assert.deepEqual(result.diagnostics, []);
  const literal = JSON.stringify(result.program);
  assert.ok(literal.includes('"key":"type"'), literal.slice(0, 400));
  assert.ok(!literal.includes('\\"type\\"'), literal.slice(0, 400));
});

test("expression precedence matches AS3", () => {
  const result = parseSource(
    "package { class A { function f():void { var x:int = 1 + 2 * 3 == 7 && true ? 4 : 5; } } }",
    "expr.as",
  );
  assert.deepEqual(result.diagnostics, []);
  const cls = result.program.declarations[0] as ClassDeclaration;
  const method = cls.members[0] as MethodDeclaration;
  const stmt = method.body!.body[0] as any;
  assert.equal(stmt.declarations[0].initializer.kind, "ConditionalExpression");
  assert.equal(stmt.declarations[0].initializer.test.operator, "&&");
});

test("parses namespaced members, class initializers, typed arrays and bracket attributes", () => {
  const result = parseFixture("Advanced.as");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.program.declarations[0]!.kind, "NamespaceDeclaration");
  const cls = result.program.declarations[1] as ClassDeclaration;
  assert.equal(cls.members[0]!.kind, "ClassInitializer");

  const wildcard = cls.members.find((m) => m.kind === "FieldDeclaration" && m.name === "wildcard") as any;
  assert.equal(wildcard.type.kind, "WildcardType");

  const hidden = cls.members.find((m) => m.kind === "FieldDeclaration" && m.name === "hidden") as any;
  assert.equal(hidden.namespace, "impl");
  const hiddenMethod = cls.members.find((m) => m.kind === "MethodDeclaration" && m.name === "hiddenMethod") as any;
  assert.equal(hiddenMethod.namespace, "impl");

  const typed = cls.members.find((m) => m.kind === "MethodDeclaration" && m.name === "typed") as MethodDeclaration;
  const typedReturn = (typed.body!.body[0] as any).expression;
  assert.equal(typedReturn.kind, "TypedArrayExpression");
  assert.equal(typedReturn.elements.length, 2);

  const attribute = cls.members.find((m) => m.kind === "MethodDeclaration" && m.name === "attribute") as MethodDeclaration;
  const assignment = (attribute.body!.body[0] as any).expression;
  assert.equal(assignment.kind, "AssignmentExpression");
  assert.equal(assignment.left.access, "attribute");
  assert.equal(assignment.left.computed, true);

  const bitwise = cls.members.find((m) => m.kind === "MethodDeclaration" && m.name === "bitwise") as MethodDeclaration;
  const ops = bitwise.body!.body.slice(1).map((s: any) => s.expression.operator);
  assert.deepEqual(ops, ["||=", "&&="]);
});

test("parses Vector coercions and postfix update member chains", () => {
  const result = parseSource(
    "package { class A { function f(items:Array):void { var v:Vector.<int> = Vector.<int>(items); var n:int = 0; n++.toString(); } } }",
    "vector-cast.as",
  );
  assert.deepEqual(result.diagnostics, []);
  const cls = result.program.declarations[0] as ClassDeclaration;
  const method = cls.members[0] as MethodDeclaration;
  const first = (method.body!.body[0] as any).declarations[0];
  assert.equal(first.initializer.kind, "CallExpression");
  assert.equal(first.initializer.callee.kind, "VectorTypeExpression");
  const second = (method.body!.body[1] as any).declarations[0];
  const expr = (method.body!.body[2] as any).expression;
  assert.equal(second.initializer.kind, "Literal");
  assert.equal(expr.kind, "CallExpression");
  assert.equal(expr.callee.object.kind, "UnaryExpression");
});

test("reports useful parser diagnostics without throwing", () => {
  const missing = parseSource("package { public class A { public function f( { } } }", "bad.as");
  assert.ok(missing.diagnostics.some((d) => d.code === "PAR001" || d.code === "PAR002"));

  const withStmt = parseSource("package { public class A { public function f():void { with (x) { y = 1; } } } }", "with.as");
  assert.ok(withStmt.diagnostics.some((d) => d.code === "PAR008"));

  const xmlNs = parseSource("package { public class A { public function f():void { default xml namespace = ns; } } }", "xmlns.as");
  assert.ok(xmlNs.diagnostics.some((d) => d.code === "PAR007"));
});
