/** Typed, serialisable intermediate representation for the first backend slice. */

import type { Span } from "../diagnostics.ts";

export interface IRProgram {
  version: 1;
  classes: IRClass[];
  interfaces: IRInterface[];
  /** Runtime manifest types this backend can bind as external bases. */
  runtimeTypes: string[];
}

export interface IRInterface {
  fqcn: string;
  name: string;
  extends: string[];
  span?: Span;
}

export interface IRParam {
  name: string;
  type: string;
  optional: boolean;
  rest: boolean;
  defaultValue: IRExpr | null;
}

export interface IRFunction {
  params: IRParam[];
  body: IRStmt[];
  span?: Span;
}

export interface IRCatch {
  name: string;
  /** Resolved type name, or null for an untyped catch-all. */
  type: string | null;
  body: IRStmt[];
}

export interface IRCase {
  /** null for the `default` clause. */
  test: IRExpr | null;
  body: IRStmt[];
}

export interface IRField {
  name: string;
  type: string;
  readonly: boolean;
  static: boolean;
}

export interface IRAccessor {
  name: string;
  type: string;
  get: IRFunction | null;
  set: IRFunction | null;
  span?: Span;
}

export interface IRMethod {
  name: string;
  type: string;
  params: IRParam[];
  body: IRStmt[];
  static: boolean;
  span?: Span;
}

export interface IRStaticValue {
  type: string;
  value: string | number | boolean | null | undefined;
  readonly: boolean;
}

export type IRMetadataValue = string | number | boolean | null | IRMetadataValue[];

export interface IRMetadataArgument {
  name: string;
  value: IRMetadataValue;
}

export interface IRMetadata {
  name: string;
  args: IRMetadataArgument[];
}

export interface IRClass {
  fqcn: string;
  name: string;
  packageName: string;
  base: string | null;
  interfaces: string[];
  metadata: IRMetadata[];
  final: boolean;
  dynamic: boolean;
  fields: IRField[];
  accessors: IRAccessor[];
  methods: IRMethod[];
  ctor: IRFunction;
  staticFields: IRField[];
  staticMethods: IRMethod[];
  staticAccessors: IRAccessor[];
  staticValues: Record<string, IRStaticValue>;
  staticInit: IRFunction | null;
  span?: Span;
}

interface IRStmtBase {
  span?: Span;
}

export type IRStmt = IRStmtBase & (
  | { k: "block"; body: IRStmt[] }
  | { k: "var"; name: string; type: string; init: IRExpr | null; const: boolean }
  | { k: "expr"; expr: IRExpr }
  | { k: "if"; test: IRExpr; then: IRStmt; else: IRStmt | null }
  | { k: "while"; test: IRExpr; body: IRStmt }
  | { k: "do"; body: IRStmt; test: IRExpr }
  | { k: "for"; init: IRStmt[]; test: IRExpr | null; update: IRExpr | null; body: IRStmt }
  | { k: "return"; value: IRExpr | null }
  | { k: "break"; label: string | null }
  | { k: "continue"; label: string | null }
  | { k: "label"; label: string; body: IRStmt }
  | {
    k: "forIn";
    each: boolean;
    declaration: { name: string; type: string } | null;
    target: IRExpr | null;
    iterable: IRExpr;
    body: IRStmt;
  }
  | { k: "throw"; value: IRExpr }
  | { k: "try"; body: IRStmt[]; catches: IRCatch[]; finalizer: IRStmt[] | null }
  | { k: "switch"; discriminant: IRExpr; cases: IRCase[] }
  | { k: "empty" }
);

export type IRExpr =
  | { k: "const"; value: string | number | boolean | null | undefined }
  | { k: "this" }
  | { k: "local"; name: string }
  | { k: "global"; name: string }
  | { k: "classRef"; fqcn: string }
  /** Imported runtime function/value, resolved through `$runtimeValue(name)`. */
  | { k: "runtimeValue"; name: string }
  /** Raw XML literal source, parsed by the runtime `XML` class. */
  | { k: "xmlLiteral"; value: string }
  /** JavaScript-compatible regex literal source, including delimiters and flags. */
  | { k: "regex"; raw: string }
  /**
   * A member value; `bound` marks a method reference that must retain its receiver.
   * `bindTo` names the declaring class for a private method reference, which AS3 binds
   * statically instead of dispatching through the instance's most derived class.
   */
  | { k: "member"; object: IRExpr; property: string; bound?: boolean; bindTo?: string }
  | { k: "runtimeClass"; fqcn: string }
  | { k: "xmlAttribute"; object: IRExpr; property: string }
  | { k: "xmlSetAttribute"; object: IRExpr; property: string; value: IRExpr }
  | { k: "xmlDescendants"; object: IRExpr; property: string }
  | { k: "xmlFilter"; object: IRExpr; predicate: IRFunction }
  | { k: "index"; object: IRExpr; index: IRExpr }
  | { k: "call"; callee: IRExpr; args: IRExpr[] }
  | { k: "construct"; classRef: IRExpr; args: IRExpr[] }
  | { k: "superCall"; base: string; name: string | null; args: IRExpr[] }
  | { k: "superGet"; base: string; property: string }
  | { k: "superSet"; base: string; property: string; value: IRExpr }
  | { k: "superUpdate"; base: string; property: string; op: "++" | "--"; prefix: boolean }
  | { k: "binary"; op: string; left: IRExpr; right: IRExpr }
  | { k: "unary"; op: string; operand: IRExpr; prefix: boolean }
  | { k: "update"; op: "++" | "--"; operand: IRExpr; prefix: boolean }
  | { k: "conditional"; test: IRExpr; then: IRExpr; else: IRExpr }
  | { k: "assign"; target: IRExpr; op: string; value: IRExpr }
  | { k: "array"; values: IRExpr[] }
  | { k: "object"; entries: Array<[string, IRExpr]> }
  | { k: "cast"; value: IRExpr; type: string }
  | { k: "is"; value: IRExpr; type: string }
  | { k: "coerce"; value: IRExpr; type: string }
  | { k: "vector"; element: string; values: IRExpr[]; length: IRExpr | null }
  | { k: "vectorCast"; element: string; value: IRExpr }
  | { k: "sequence"; expressions: IRExpr[] }
  /** AS3 function expression; captures the enclosing `this` and locals. */
  | { k: "function"; name: string | null; params: IRParam[]; body: IRStmt[] };