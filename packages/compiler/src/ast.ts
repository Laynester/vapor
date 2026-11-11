import type { Span } from "./diagnostics.ts";

export interface Node {
  kind: string;
  span: Span;
}

/* ------------------------------------------------------------------------- */
/* Program and declarations                                                  */
/* ------------------------------------------------------------------------- */

export interface Program extends Node {
  kind: "Program";
  packageName: string | null;
  imports: ImportDeclaration[];
  declarations: TopLevelDeclaration[];
}

export interface ImportDeclaration extends Node {
  kind: "ImportDeclaration";
  name: string;
  wildcard: boolean;
}

export type Modifier =
  | "public"
  | "private"
  | "protected"
  | "internal"
  | "static"
  | "final"
  | "override"
  | "dynamic"
  | "native";

export interface Metadata extends Node {
  kind: "Metadata";
  name: string;
  args: MetadataArgument[];
  raw: string;
}

export interface MetadataArgument extends Node {
  kind: "MetadataArgument";
  name: string | null;
  value: MetadataValue;
}

export type MetadataValue =
  | string
  | number
  | boolean
  | null
  | { kind: "IdentifierValue"; name: string }
  | { kind: "ArrayValue"; values: MetadataValue[] };

export type TopLevelDeclaration =
  | ClassDeclaration
  | InterfaceDeclaration
  | NamespaceDeclaration;

export interface ClassDeclaration extends Node {
  kind: "ClassDeclaration";
  name: string;
  modifiers: Modifier[];
  metadata: Metadata[];
  extends: TypeNode | null;
  implements: TypeNode[];
  members: ClassMember[];
}

export interface InterfaceDeclaration extends Node {
  kind: "InterfaceDeclaration";
  name: string;
  modifiers: Modifier[];
  metadata: Metadata[];
  extends: TypeNode[];
  members: ClassMember[];
}

export type ClassMember =
  | FieldDeclaration
  | MethodDeclaration
  | NamespaceDeclaration
  | ClassInitializer;

export interface FieldDeclaration extends Node {
  kind: "FieldDeclaration";
  name: string;
  isConst: boolean;
  type: TypeNode | null;
  initializer: Expression | null;
  modifiers: Modifier[];
  metadata: Metadata[];
  /** AS3 namespace attribute such as `bi_internal` or `flash_proxy`. */
  namespace?: string;
}

export interface MethodDeclaration extends Node {
  kind: "MethodDeclaration";
  name: string;
  accessor: "get" | "set" | null;
  isConstructor: boolean;
  params: Parameter[];
  returnType: TypeNode | null;
  body: BlockStatement | null;
  modifiers: Modifier[];
  metadata: Metadata[];
  /** AS3 namespace attribute such as `bi_internal` or `flash_proxy`. */
  namespace?: string;
}

export interface NamespaceDeclaration extends Node {
  kind: "NamespaceDeclaration";
  name: string;
  value: string | null;
  modifiers: Modifier[];
  namespace?: string;
}

/** An instance/static initializer block inside a class body. */
export interface ClassInitializer extends Node {
  kind: "ClassInitializer";
  body: BlockStatement;
  modifiers: Modifier[];
  metadata: Metadata[];
}

export interface Parameter extends Node {
  kind: "Parameter";
  name: string;
  type: TypeNode | null;
  defaultValue: Expression | null;
  rest: boolean;
}

/* ------------------------------------------------------------------------- */
/* Types                                                                     */
/* ------------------------------------------------------------------------- */

export interface NamedTypeNode extends Node {
  kind: "NamedType";
  name: string;
  namespace: string | null;
}

export interface WildcardTypeNode extends Node {
  kind: "WildcardType";
}

export interface VectorTypeNode extends Node {
  kind: "VectorType";
  element: TypeNode;
}

export type TypeNode = NamedTypeNode | WildcardTypeNode | VectorTypeNode;

/* ------------------------------------------------------------------------- */
/* Statements                                                                */
/* ------------------------------------------------------------------------- */

export interface BlockStatement extends Node {
  kind: "BlockStatement";
  body: Statement[];
}

export interface VariableStatement extends Node {
  kind: "VariableStatement";
  isConst: boolean;
  declarations: VariableDeclaration[];
}

export interface VariableDeclaration extends Node {
  kind: "VariableDeclaration";
  name: string;
  type: TypeNode | null;
  initializer: Expression | null;
}

export interface EmptyStatement extends Node {
  kind: "EmptyStatement";
}

export interface ExpressionStatement extends Node {
  kind: "ExpressionStatement";
  expression: Expression;
}

export interface IfStatement extends Node {
  kind: "IfStatement";
  test: Expression;
  consequent: Statement;
  alternate: Statement | null;
}

export interface WhileStatement extends Node {
  kind: "WhileStatement";
  test: Expression;
  body: Statement;
}

export interface WithStatement extends Node {
  kind: "WithStatement";
  object: Expression;
  body: Statement;
}

export interface DoWhileStatement extends Node {
  kind: "DoWhileStatement";
  body: Statement;
  test: Expression;
}

export interface ForStatement extends Node {
  kind: "ForStatement";
  init: VariableDeclaration[] | Expression | null;
  test: Expression | null;
  update: Expression | null;
  body: Statement;
}

export interface ForInStatement extends Node {
  kind: "ForInStatement";
  each: boolean;
  declaration: VariableDeclaration | null;
  /** Loop variable reference when `declaration` is null. */
  target: Expression;
  /** Collection being enumerated (`in` operand). */
  iterable: Expression;
  body: Statement;
}

export interface SwitchStatement extends Node {
  kind: "SwitchStatement";
  discriminant: Expression;
  cases: SwitchCase[];
}

export interface SwitchCase extends Node {
  kind: "SwitchCase";
  test: Expression | null;
  statements: Statement[];
}

export interface TryStatement extends Node {
  kind: "TryStatement";
  block: BlockStatement;
  catches: CatchClause[];
  finalizer: BlockStatement | null;
}

export interface CatchClause extends Node {
  kind: "CatchClause";
  name: string;
  type: TypeNode | null;
  block: BlockStatement;
}

export interface ThrowStatement extends Node {
  kind: "ThrowStatement";
  expression: Expression;
}

export interface ReturnStatement extends Node {
  kind: "ReturnStatement";
  expression: Expression | null;
}

export interface BreakStatement extends Node {
  kind: "BreakStatement";
  label: string | null;
}

export interface ContinueStatement extends Node {
  kind: "ContinueStatement";
  label: string | null;
}

export interface LabeledStatement extends Node {
  kind: "LabeledStatement";
  label: string;
  statement: Statement;
}

export interface FunctionDeclarationStatement extends Node {
  kind: "FunctionDeclarationStatement";
  declaration: MethodDeclaration;
}

export type Statement =
  | BlockStatement
  | VariableStatement
  | EmptyStatement
  | ExpressionStatement
  | IfStatement
  | WhileStatement
  | DoWhileStatement
  | ForStatement
  | ForInStatement
  | SwitchStatement
  | TryStatement
  | ThrowStatement
  | ReturnStatement
  | BreakStatement
  | ContinueStatement
  | LabeledStatement
  | FunctionDeclarationStatement
  | WithStatement;

/* ------------------------------------------------------------------------- */
/* Expressions                                                               */
/* ------------------------------------------------------------------------- */

export interface Identifier extends Node {
  kind: "Identifier";
  name: string;
}

export interface ThisExpression extends Node {
  kind: "ThisExpression";
}

export interface SuperExpression extends Node {
  kind: "SuperExpression";
}

export type LiteralKind =
  | "number"
  | "string"
  | "boolean"
  | "null"
  | "regex"
  | "xml"
  | "undefined";

export interface LiteralExpression extends Node {
  kind: "Literal";
  literalKind: LiteralKind;
  raw: string;
  /** Decoded value for simple literals; raw XML/regex keep their source text. */
  value: string | number | boolean | null;
}

export interface ArrayLiteral extends Node {
  kind: "ArrayLiteral";
  /** null entries represent elisions. */
  elements: (Expression | null)[];
}

/** AS3 typed array literal: `new <T>[a, b]`. */
export interface TypedArrayExpression extends Node {
  kind: "TypedArrayExpression";
  elementType: TypeNode;
  elements: (Expression | null)[];
}

export interface ObjectLiteral extends Node {
  kind: "ObjectLiteral";
  properties: ObjectProperty[];
}

export interface ObjectProperty extends Node {
  kind: "ObjectProperty";
  key: string;
  value: Expression;
}

export interface FunctionExpression extends Node {
  kind: "FunctionExpression";
  name: string | null;
  params: Parameter[];
  returnType: TypeNode | null;
  body: BlockStatement;
}

export interface NewExpression extends Node {
  kind: "NewExpression";
  target: Expression;
  args: Expression[];
}

export interface CallExpression extends Node {
  kind: "CallExpression";
  callee: Expression;
  args: Expression[];
}

export type MemberAccess =
  | "dot"
  | "attribute"
  | "descendant"
  | "wildcard"
  | "qualified";

export interface MemberExpression extends Node {
  kind: "MemberExpression";
  object: Expression;
  property: string | Expression;
  computed: boolean;
  access: MemberAccess;
  namespace: string | null;
}

export interface XmlFilterExpression extends Node {
  kind: "XmlFilterExpression";
  object: Expression;
  predicate: Expression;
}

export interface UnaryExpression extends Node {
  kind: "UnaryExpression";
  operator: string;
  operand: Expression;
  prefix: boolean;
}

export interface BinaryExpression extends Node {
  kind: "BinaryExpression";
  operator: string;
  left: Expression;
  right: Expression;
}

export interface ConditionalExpression extends Node {
  kind: "ConditionalExpression";
  test: Expression;
  consequent: Expression;
  alternate: Expression;
}

export interface AssignmentExpression extends Node {
  kind: "AssignmentExpression";
  operator: string;
  left: Expression;
  right: Expression;
}

export interface TypeTestExpression extends Node {
  kind: "TypeTestExpression";
  operator: "is" | "as";
  expression: Expression;
  type: TypeNode;
}

export interface SequenceExpression extends Node {
  kind: "SequenceExpression";
  expressions: Expression[];
}

export interface ParenthesizedExpression extends Node {
  kind: "ParenthesizedExpression";
  expression: Expression;
}

/** `Vector.<T>` in an expression (currently only as a `new` target). */
export interface VectorTypeExpression extends Node {
  kind: "VectorTypeExpression";
  element: TypeNode;
}

/** `ns::name` where the namespace qualifier is a primary expression. */
export interface QualifiedNameExpression extends Node {
  kind: "QualifiedNameExpression";
  namespace: string;
  name: string;
}

/** `@name` inside an E4X filter predicate. */
export interface AttributeSelectorExpression extends Node {
  kind: "AttributeSelectorExpression";
  name: string;
}

export type Expression =
  | Identifier
  | ThisExpression
  | SuperExpression
  | LiteralExpression
  | ArrayLiteral
  | TypedArrayExpression
  | ObjectLiteral
  | FunctionExpression
  | NewExpression
  | CallExpression
  | MemberExpression
  | XmlFilterExpression
  | UnaryExpression
  | BinaryExpression
  | ConditionalExpression
  | AssignmentExpression
  | TypeTestExpression
  | SequenceExpression
  | ParenthesizedExpression
  | VectorTypeExpression
  | QualifiedNameExpression
  | AttributeSelectorExpression;

/** Stable, span-free projection used by AST snapshot tests. */
export function toSnapshot(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toSnapshot);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === "span") continue;
      out[key] = toSnapshot(value);
    }
    return out;
  }
  return node;
}
