import test from "node:test";
import assert from "node:assert/strict";
import { Lexer } from "../../packages/compiler/src/lexer/lexer.ts";

function lex(source: string) {
  return new Lexer(source, "test.as").tokenize();
}

function texts(source: string): string[] {
  return lex(source).tokens.map((t) => t.text);
}

test("tokenizes a minimal AS3 compilation unit", () => {
  const { tokens, diagnostics } = lex(`
package {
  import flash.display.MovieClip;
  public class Main extends MovieClip {
    public function Main() {
      trace("Hello from AS3");
    }
  }
}
`);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    tokens.map((t) => t.text),
    [
      "package", "{", "import", "flash", ".", "display", ".", "MovieClip", ";",
      "public", "class", "Main", "extends", "MovieClip", "{",
      "public", "function", "Main", "(", ")", "{",
      "trace", "(", '"Hello from AS3"', ")", ";",
      "}", "}", "}", "",
    ],
  );
});

test("records line, column and leading newline", () => {
  const { tokens } = lex("var a:int;\nvar b:int;");
  const a = tokens.find((t) => t.text === "a")!;
  const b = tokens.find((t) => t.text === "b")!;
  const secondVar = tokens.filter((t) => t.text === "var")[1]!;
  assert.equal(a.line, 1);
  assert.equal(a.column, 5);
  assert.equal(b.line, 2);
  assert.equal(secondVar.leadingNewline, true);
  assert.equal(tokens.at(-1)!.kind, "eof");
});

test("skips line and block comments but keeps newlines", () => {
  const { tokens, diagnostics } = lex("// one\n/* two\nthree */\nvar x:int;");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(tokens.map((t) => t.text), ["var", "x", ":", "int", ";", ""]);
  assert.equal(tokens[0]!.line, 4);
});

test("handles string escapes and single quotes", () => {
  const { tokens, diagnostics } = lex(`var s:String = "a\\"b\\\\c\\n"; var t = 'x';`);
  assert.deepEqual(diagnostics, []);
  const strings = tokens.filter((t) => t.kind === "string");
  assert.equal(strings[0]!.text, '"a\\"b\\\\c\\n"');
  assert.equal(strings[1]!.text, "'x'");
});

test("distinguishes regex literals from division", () => {
  const regex = lex("var r:RegExp = /ab+c/gi;");
  assert.equal(regex.diagnostics.length, 0);
  assert.equal(regex.tokens.find((t) => t.kind === "regex")!.text, "/ab+c/gi");

  const division = lex("var x:Number = a / b / c;");
  assert.equal(division.diagnostics.length, 0);
  assert.equal(division.tokens.filter((t) => t.kind === "regex").length, 0);
  assert.deepEqual(
    division.tokens.filter((t) => t.kind === "punct").map((t) => t.text),
    [":", "=", "/", "/", ";"],
  );
});

test("tokenizes numbers", () => {
  const { tokens, diagnostics } = lex("var x = 0x0400 + 1.5e-3 + .25 + 10.;");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    tokens.filter((t) => t.kind === "number").map((t) => t.text),
    ["0x0400", "1.5e-3", ".25", "10."],
  );
});

test("tokenizes multi-character operators", () => {
  assert.deepEqual(texts("a >>>= b; c === d; e >>> f; g .. h; i ... j; k::l;"), [
    "a", ">>>=", "b", ";", "c", "===", "d", ";", "e", ">>>", "f", ";", "g", "..", "h", ";",
    "i", "...", "j", ";", "k", "::", "l", ";", "",
  ]);
  assert.deepEqual(texts("a ||= b; c &&= d;"), ["a", "||=", "b", ";", "c", "&&=", "d", ";", ""]);
});

test("lexes a nested XML literal as one token", () => {
  const source = `var xml:XML = <config><library url="hh_human_body.swf"/><item>text</item></config>;`;
  const { tokens, diagnostics } = lex(source);
  assert.deepEqual(diagnostics, []);
  const xml = tokens.find((t) => t.kind === "xml")!;
  assert.equal(
    xml.text,
    `<config><library url="hh_human_body.swf"/><item>text</item></config>`,
  );
  assert.equal(tokens.find((t) => t.text === "=")!.kind, "punct");
});

test("lexes XML CDATA containing quotes, slashes and angle brackets", () => {
  const source = `public static const CODE:XML = <script><![CDATA[
    var a = "</div>"; // not a comment in XML
    if (a < b) { return "<"; }
  ]]></script>;`;
  const { tokens, diagnostics } = lex(source);
  assert.deepEqual(diagnostics, []);
  const xml = tokens.find((t) => t.kind === "xml")!;
  assert.match(xml.text, /^<script><!\[CDATA\[/);
  assert.match(xml.text, /\]\]><\/script>$/);
});

test("does not treat less-than comparisons as XML", () => {
  const { tokens, diagnostics } = lex("if (a < b && c > d) { x = y; }");
  assert.deepEqual(diagnostics, []);
  assert.equal(tokens.filter((t) => t.kind === "xml").length, 0);
  assert.equal(tokens.filter((t) => t.text === "<").length, 1);
});

test("recognises E4X attribute and descendant punctuation", () => {
  const { tokens, diagnostics } = lex("var x = a.@id; var y = b..item; var z = c..*;");
  assert.deepEqual(diagnostics, []);
  assert.ok(tokens.some((t) => t.text === "@"));
  assert.equal(tokens.filter((t) => t.text === "..").length, 2);
});

test("reports unterminated strings and XML literals", () => {
  const str = lex('var s:String = "oops;');
  assert.equal(str.diagnostics[0]!.code, "LEX002");
  const xml = lex("var x:XML = <root><child></root>;");
  assert.equal(xml.diagnostics.length, 1);
  assert.equal(xml.diagnostics[0]!.code, "LEX005");
  assert.equal(lex("var x:XML = <root><child>;").diagnostics[0]!.code, "LEX006");
});

test("uses spans that slice back to the token text", () => {
  const source = "var foo = 1;";
  const { tokens } = lex(source);
  for (const token of tokens) {
    if (token.kind === "eof") continue;
    assert.equal(source.slice(token.start, token.end), token.text);
  }
});
