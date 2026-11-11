import type { Span } from "../diagnostics.ts";

/** A type as seen by the checker. Names are deterministic and serialisable. */
export type SemanticTypeKind =
  | "class"
  | "interface"
  | "primitive"
  | "vector"
  | "function"
  | "any"
  | "void"
  | "null"
  | "undefined"
  | "classRef"
  | "unknown";

export interface SemanticType {
  kind: SemanticTypeKind;
  /** FQCN for named types, `Vector.<T>` for vectors, or a primitive name. */
  name: string;
  fqcn?: string;
  external?: boolean;
  element?: SemanticType;
}

export type MemberKind = "field" | "method" | "getter" | "setter";
export type MemberVisibility = "public" | "private" | "protected" | "internal" | "custom";

export interface ParamInfo {
  name: string;
  type: string;
  optional: boolean;
  rest: boolean;
}

export interface MemberInfo {
  name: string;
  namespace: string;
  access: MemberVisibility;
  kind: MemberKind;
  /** Field/getter type, method return type, or setter value type. */
  type: string;
  params: ParamInfo[];
  static: boolean;
  final: boolean;
  override: boolean;
  isConst: boolean;
  declaredIn: string;
  span: Span;
}

export interface TypeFlags {
  final: boolean;
  dynamic: boolean;
  external: boolean;
}

export interface TypeInfo {
  fqcn: string;
  name: string;
  packageName: string;
  kind: "class" | "interface";
  origin: "source" | "runtime" | "builtin";
  file?: string;
  base: string | null;
  interfaces: string[];
  members: MemberInfo[];
  statics: MemberInfo[];
  constructors: MemberInfo[];
  flags: TypeFlags;
  modifiers: string[];
  metadata: TypeMetadata[];
  /** True when a source class has any static field initializer or static block. */
  hasStaticInitializer: boolean;
}

export interface TypeMetadata {
  name: string;
  args: TypeMetadataArgument[];
}

export interface TypeMetadataArgument {
  name: string | null;
  value: unknown;
}

export interface ClassInitEdge {
  from: string;
  to: string;
}

export interface ClassInitGraph {
  edges: ClassInitEdge[];
  cycles: string[][];
}

export interface RuntimeGraphSummary {
  types: string[];
  packages: string[];
  values: string[];
  namespaces: string[];
}

/** Serializable project output. It intentionally contains no object cycles. */
export interface ProjectGraph {
  version: 1;
  types: TypeInfo[];
  runtime: RuntimeGraphSummary;
  classInit: ClassInitGraph;
}

export interface RuntimeMemberUse {
  /** External runtime type the access was made against. */
  fqcn: string;
  member: string;
  count: number;
  file: string;
  line: number;
}

export interface SemanticResult {
  graph: ProjectGraph;
  diagnostics: import("../diagnostics.ts").Diagnostic[];
  /** External members used by the corpus that the runtime manifest does not declare. */
  memberAudit: RuntimeMemberUse[];
}

export function typeName(type: SemanticType): string {
  if (type.kind === "vector" && type.element) return `Vector.<${typeName(type.element)}>`;
  return type.name;
}

export function sameType(a: SemanticType, b: SemanticType): boolean {
  return typeName(a) === typeName(b);
}

export function isUnknown(type: SemanticType): boolean {
  return type.kind === "unknown";
}

export function isAny(type: SemanticType): boolean {
  return type.kind === "any";
}

export function isClassLike(type: SemanticType): boolean {
  return type.kind === "class" || type.kind === "interface" || type.kind === "classRef";
}
