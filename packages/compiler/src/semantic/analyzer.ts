import type * as AST from "../ast.ts";
import { diag, type Diagnostic, type Span } from "../diagnostics.ts";
import { parseSource } from "../parser/parser.ts";
import {
  type ClassInitEdge,
  type MemberInfo,
  type RuntimeMemberUse,
  type MemberKind,
  type ParamInfo,
  type ProjectGraph,
  type SemanticResult,
  type SemanticType,
  type TypeInfo,
  type TypeMetadata,
  type ClassInitGraph,
} from "./types.ts";
import {
  DEFAULT_RUNTIME_MANIFEST,
  type RuntimeManifest,
} from "./runtime-manifest.ts";

export interface SourceUnit {
  file: string;
  program: AST.Program;
  diagnostics?: readonly Diagnostic[];
}

export interface AnalyzeOptions {
  runtime?: RuntimeManifest;
}

interface FileContext {
  unit: SourceUnit;
  packageName: string;
  explicitImports: Map<string, string>;
  wildcardImports: string[];
  namespaces: Set<string>;
}

interface Binding {
  type: SemanticType;
  const: boolean;
}

class Scope {
  readonly values = new Map<string, Binding>();
  readonly parent: Scope | null;

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  lookup(name: string): Binding | null {
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      const value = scope.values.get(name);
      if (value) return value;
    }
    return null;
  }

  declare(name: string, type: SemanticType, isConst = false): void {
    this.values.set(name, { type, const: isConst });
  }
}

interface CheckState {
  ctx: FileContext;
  currentType: TypeInfo;
  currentMember: MemberInfo | null;
  inStatic: boolean;
  returnType: string;
  scope: Scope;
  functionScope: Scope;
  loopDepth: number;
  switchDepth: number;
  labels: ReadonlySet<string>;
}

interface MemberLookup {
  member: MemberInfo | null;
  type: SemanticType;
}

const ANY: SemanticType = { kind: "any", name: "*" };
const UNKNOWN: SemanticType = { kind: "unknown", name: "unknown" };
const VOID: SemanticType = { kind: "void", name: "void" };
const FUNCTION: SemanticType = { kind: "function", name: "Function" };
const BOOLEAN: SemanticType = { kind: "primitive", name: "Boolean" };
const NUMBER: SemanticType = { kind: "primitive", name: "Number" };
const INT: SemanticType = { kind: "primitive", name: "int" };
const STRING: SemanticType = { kind: "primitive", name: "String" };
const XML: SemanticType = { kind: "class", name: "XML", fqcn: "XML" };

const PRIMITIVE_NAMES = new Set([
  "int",
  "uint",
  "Number",
  "Boolean",
  "String",
  "void",
  "Null",
  "Undefined",
  "null",
  "undefined",
]);

const NUMERIC_NAMES = new Set(["int", "uint", "Number"]);
const PRIMITIVE_TYPES = new Map<string, SemanticType>([
  ["int", INT],
  ["uint", { kind: "primitive", name: "uint" }],
  ["Number", NUMBER],
  ["Boolean", BOOLEAN],
  ["String", STRING],
  ["void", VOID],
  ["Null", { kind: "primitive", name: "Null" }],
  ["Undefined", { kind: "primitive", name: "Undefined" }],
]);

const BUILTIN_CLASS_NAMES = [
  "Object",
  "Array",
  "Class",
  "Vector",
  "XML",
  "XMLList",
  "QName",
  "Namespace",
  "RegExp",
  "Date",
  "Math",
  "JSON",
  "Error",
  "ArgumentError",
  "DefinitionError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SecurityError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "VerifyError",
];

const ERROR_NAMES = new Set([
  "Error",
  "ArgumentError",
  "DefinitionError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SecurityError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "VerifyError",
]);

const GLOBAL_FUNCTIONS = new Set([
  "trace",
  "isFinite",
  "isNaN",
  "parseInt",
  "parseFloat",
  "escape",
  "unescape",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
]);

const ACCESS_RANK: Record<MemberInfo["access"], number> = {
  private: 0,
  internal: 1,
  protected: 2,
  public: 3,
  custom: 3,
};

const NUMERIC = new Set(["int", "uint", "Number"]);

/** Runtime types whose members are intentionally dynamic; accesses are not audit gaps. */
const DYNAMIC_RUNTIME_TYPES = new Set(["flash.utils.Dictionary", "flash.net.URLVariables"]);

export class SemanticAnalyzer {
  private readonly units: SourceUnit[];
  private readonly runtime: RuntimeManifest;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly types = new Map<string, TypeInfo>();
  private readonly sourceTypes = new Map<string, TypeInfo>();
  private readonly sourceDecls = new Map<
    string,
    { decl: AST.ClassDeclaration | AST.InterfaceDeclaration; ctx: FileContext }
  >();
  private readonly contexts = new Map<string, FileContext>();
  private readonly typeNodeCache = new WeakMap<object, SemanticType>();
  private readonly memberInfoByNode = new WeakMap<AST.Node, MemberInfo>();
  private readonly unresolvedTypeKeys = new Set<string>();
  private readonly runtimeMemberUses = new Map<string, RuntimeMemberUse>();
  private readonly runtimePackages = new Set<string>();
  private readonly runtimeValues = new Set<string>();
  private readonly runtimeNamespaces = new Set<string>();
  private readonly packageRoots = new Set<string>();

  constructor(units: readonly SourceUnit[], options: AnalyzeOptions = {}) {
    this.units = [...units].sort((a, b) => a.file.localeCompare(b.file));
    this.runtime = options.runtime ?? DEFAULT_RUNTIME_MANIFEST;
    this.addBuiltins();
    this.addRuntime();
    for (const unit of this.units) {
      this.contexts.set(unit.file, this.createContext(unit));
    }
  }

  analyze(): SemanticResult {
    for (const unit of this.units) {
      if (unit.diagnostics) this.diagnostics.push(...unit.diagnostics);
    }

    this.registerSourceTypes();
    this.collectPackageRoots();
    for (const [, reference] of this.sourceDecls) {
      this.populateType(reference.decl, reference.ctx);
    }

    this.resolveHierarchy();
    this.checkInheritanceCycles();
    this.checkOverrides();
    this.checkImplementations();
    for (const [, reference] of this.sourceDecls) {
      this.checkDeclarationBodies(reference.decl, reference.ctx);
    }

    const classInit = this.buildClassInitGraph();
    const graph: ProjectGraph = {
      version: 1,
      types: [...this.sourceTypes.values()].sort((a, b) => a.fqcn.localeCompare(b.fqcn)),
      runtime: {
        types: this.runtime.types.map((t) => t.fqcn).sort(),
        packages: [...this.runtime.packages].sort(),
        values: [...this.runtime.values].sort(),
        namespaces: [...this.runtime.namespaces].sort(),
      },
      classInit,
    };

    this.diagnostics.sort(compareDiagnostics);
    const memberAudit = [...this.runtimeMemberUses.values()].sort(
      (a, b) =>
        b.count - a.count ||
        a.fqcn.localeCompare(b.fqcn) ||
        a.member.localeCompare(b.member),
    );
    return { graph, diagnostics: this.diagnostics, memberAudit };
  }

  private createContext(unit: SourceUnit): FileContext {
    const explicitImports = new Map<string, string>();
    const wildcardImports: string[] = [];
    for (const declaration of unit.program.imports) {
      if (declaration.wildcard) {
        wildcardImports.push(declaration.name);
      } else {
        explicitImports.set(simpleName(declaration.name), declaration.name);
      }
    }

    const namespaces = new Set<string>();
    for (const declaration of unit.program.declarations) {
      if (declaration.kind === "NamespaceDeclaration") namespaces.add(declaration.name);
    }

    return {
      unit,
      packageName: unit.program.packageName ?? "",
      explicitImports,
      wildcardImports,
      namespaces,
    };
  }

  private addBuiltins(): void {
    for (const name of BUILTIN_CLASS_NAMES) {
      const base =
        name === "Object" || name === "Class" || name === "Vector" ? null :
        name === "Array" || name === "XML" || name === "XMLList" || name === "QName" ||
        name === "Namespace" || name === "RegExp" || name === "Date" || name === "Math" ||
        name === "JSON" ? "Object" : ERROR_NAMES.has(name) ? "Error" : "Object";
      this.types.set(name, this.makeTypeInfo({
        fqcn: name,
        kind: "class",
        origin: "builtin",
        base,
      }));
    }
    // Error itself is the root of the Error hierarchy.
    const error = this.types.get("Error");
    if (error) error.base = "Object";

    // The runtime owns full implementations; these declarations are the members the
    // semantic checker needs for ordinary Error/Object use in the corpus.
    this.addBuiltinField("Error", "name", "String");
    this.addBuiltinField("Error", "message", "String");
    this.addBuiltinField("Error", "errorID", "int");
    this.addBuiltinField("Error", "stack", "String");
    this.addBuiltinField("Object", "constructor", "Class");
    this.addBuiltinMethod("Object", "toString", "String");
    this.addBuiltinMethod("Object", "hasOwnProperty", "Boolean", ["String"]);
    this.addBuiltinMethod("Object", "valueOf", "Object");
  }

  private addBuiltinField(typeName: string, name: string, type: string): void {
    const info = this.types.get(typeName);
    if (!info) return;
    info.members.push({
      name,
      namespace: "public",
      access: "public",
      kind: "field",
      type,
      params: [],
      static: false,
      final: false,
      override: false,
      isConst: false,
      declaredIn: typeName,
      span: fallbackSpan(),
    });
  }

  private addBuiltinMethod(
    typeName: string,
    name: string,
    returnType: string,
    paramTypes: string[] = [],
  ): void {
    const info = this.types.get(typeName);
    if (!info) return;
    info.members.push({
      name,
      namespace: "public",
      access: "public",
      kind: "method",
      type: returnType,
      params: paramTypes.map((type, index) => ({
        name: `arg${index}`,
        type,
        optional: true,
        rest: false,
      })),
      static: false,
      final: false,
      override: false,
      isConst: false,
      declaredIn: typeName,
      span: fallbackSpan(),
    });
  }

  private addRuntime(): void {
    for (const packageName of this.runtime.packages) this.runtimePackages.add(packageName);
    for (const value of this.runtime.values) this.runtimeValues.add(value);
    for (const namespace of this.runtime.namespaces) this.runtimeNamespaces.add(namespace);

    for (const declaration of this.runtime.types) {
      const info = this.makeTypeInfo({
        fqcn: declaration.fqcn,
        kind: declaration.kind,
        origin: "runtime",
        base: declaration.base ?? (declaration.kind === "class" ? "Object" : null),
        interfaces: declaration.interfaces ?? [],
        external: true,
      });
      for (const member of declaration.members ?? []) {
        const infoMember: MemberInfo = {
          name: member.name,
          namespace: "public",
          access: "public",
          kind: member.kind,
          type: member.type,
          params: (member.params ?? []).map((param) => ({
            name: param.name,
            type: param.type,
            optional: param.optional ?? false,
            rest: param.rest ?? false,
          })),
          static: member.static ?? false,
          final: false,
          override: false,
          isConst: member.readonly ?? false,
          declaredIn: declaration.fqcn,
          span: fallbackSpan(),
        };
        (infoMember.static ? info.statics : info.members).push(infoMember);
      }
      this.types.set(declaration.fqcn, info);
    }
  }

  private makeTypeInfo(input: {
    fqcn: string;
    kind: "class" | "interface";
    origin: "source" | "runtime" | "builtin";
    file?: string;
    base?: string | null;
    interfaces?: string[];
    external?: boolean;
  }): TypeInfo {
    const separator = input.fqcn.lastIndexOf(".");
    return {
      fqcn: input.fqcn,
      name: separator >= 0 ? input.fqcn.slice(separator + 1) : input.fqcn,
      packageName: separator >= 0 ? input.fqcn.slice(0, separator) : "",
      kind: input.kind,
      origin: input.origin,
      ...(input.file ? { file: input.file } : {}),
      base: input.base ?? null,
      interfaces: input.interfaces ?? [],
      members: [],
      statics: [],
      constructors: [],
      flags: { final: false, dynamic: false, external: input.external ?? false },
      modifiers: [],
      metadata: [],
      hasStaticInitializer: false,
    };
  }

  private registerSourceTypes(): void {
    for (const unit of this.units) {
      const ctx = this.contexts.get(unit.file);
      if (!ctx) continue;
      for (const declaration of unit.program.declarations) {
        if (
          declaration.kind !== "ClassDeclaration" &&
          declaration.kind !== "InterfaceDeclaration"
        ) {
          continue;
        }

        const fqcn = qualifiedName(ctx.packageName, declaration.name);
        if (this.types.has(fqcn)) {
          this.error(
            "SEM001",
            `Duplicate type '${fqcn}'`,
            declaration.span,
            [`Already declared in ${this.types.get(fqcn)?.file ?? "a built-in/runtime declaration"}`],
          );
          continue;
        }

        const info = this.makeTypeInfo({
          fqcn,
          kind: declaration.kind === "InterfaceDeclaration" ? "interface" : "class",
          origin: "source",
          file: unit.file,
          base: declaration.kind === "ClassDeclaration" ? "Object" : null,
        });
        info.modifiers = [...declaration.modifiers];
        info.flags.final = declaration.modifiers.includes("final");
        info.flags.dynamic = declaration.modifiers.includes("dynamic");
        info.metadata = metadataInfo(declaration.metadata);
        this.types.set(fqcn, info);
        this.sourceTypes.set(fqcn, info);
        this.sourceDecls.set(fqcn, { decl: declaration, ctx });
      }
    }
  }

  private populateType(
    declaration: AST.ClassDeclaration | AST.InterfaceDeclaration,
    ctx: FileContext,
  ): void {
    const info = this.sourceTypes.get(qualifiedName(ctx.packageName, declaration.name));
    if (!info) return;

    for (const member of declaration.members) {
      if (member.kind === "NamespaceDeclaration") continue;

      if (member.kind === "ClassInitializer") {
        if (member.modifiers.includes("static")) info.hasStaticInitializer = true;
        continue;
      }

      if (member.kind === "FieldDeclaration") {
        const type = member.type ? this.typeNameOf(this.resolveType(member.type, ctx)) : "*";
        const isInterface = declaration.kind === "InterfaceDeclaration";
        const memberInfo: MemberInfo = {
          name: member.name,
          namespace: member.namespace ?? accessOf(member.modifiers, isInterface),
          access: accessKind(member.modifiers, member.namespace ?? null, isInterface),
          kind: "field",
          type,
          params: [],
          static: member.modifiers.includes("static"),
          final: member.modifiers.includes("final"),
          override: member.modifiers.includes("override"),
          isConst: member.isConst,
          declaredIn: info.fqcn,
          span: member.span,
        };
        this.addMember(info, memberInfo, ctx);
        this.memberInfoByNode.set(member, memberInfo);
        if (memberInfo.static && member.initializer) info.hasStaticInitializer = true;
        continue;
      }

      if (member.kind === "MethodDeclaration") {
        const params: ParamInfo[] = member.params.map((param) => ({
          name: param.name,
          type: param.type ? this.typeNameOf(this.resolveType(param.type, ctx)) : "*",
          optional: param.defaultValue !== null,
          rest: param.rest,
        }));
        const isConstructor = member.isConstructor;
        const returnType = isConstructor
          ? "void"
          : member.returnType
            ? this.typeNameOf(this.resolveType(member.returnType, ctx))
            : "*";
        const kind: MemberKind = isConstructor
          ? "method"
          : member.accessor === "get"
            ? "getter"
            : member.accessor === "set"
              ? "setter"
              : "method";
        const type = kind === "setter"
          ? params[0]?.type ?? "*"
          : returnType;
        const isInterface = declaration.kind === "InterfaceDeclaration";
        const memberInfo: MemberInfo = {
          name: member.name,
          namespace: member.namespace ?? accessOf(member.modifiers, isInterface),
          access: accessKind(member.modifiers, member.namespace ?? null, isInterface),
          kind,
          type,
          params,
          static: member.modifiers.includes("static"),
          final: member.modifiers.includes("final"),
          override: member.modifiers.includes("override"),
          isConst: false,
          declaredIn: info.fqcn,
          span: member.span,
        };

        if (isConstructor) {
          if (info.constructors.length > 0) {
            this.error("SEM012", `Duplicate constructor in '${info.fqcn}'`, member.span);
          } else {
            info.constructors.push(memberInfo);
            this.memberInfoByNode.set(member, memberInfo);
          }
        } else {
          this.addMember(info, memberInfo, ctx);
          this.memberInfoByNode.set(member, memberInfo);
        }
      }
    }
  }

  private addMember(info: TypeInfo, member: MemberInfo, _ctx: FileContext): void {
    const list = member.static ? info.statics : info.members;
    const conflict = list.find((existing) =>
      existing.name === member.name &&
      existing.namespace === member.namespace &&
      (
        existing.kind === member.kind ||
        !isAccessor(existing.kind) ||
        !isAccessor(member.kind)
      ),
    );
    if (conflict) {
      this.error(
        "SEM012",
        `Duplicate member '${member.name}' in '${info.fqcn}'`,
        member.span,
        [`Previous declaration is a ${conflict.kind} at line ${conflict.span.line}`],
      );
      return;
    }
    list.push(member);
  }

  private resolveHierarchy(): void {
    for (const [fqcn, reference] of this.sourceDecls) {
      const info = this.types.get(fqcn);
      if (!info) continue;
      const { decl, ctx } = reference;

      if (decl.kind === "ClassDeclaration") {
        if (decl.extends) {
          const base = this.resolveType(decl.extends, ctx);
          if (base.kind !== "unknown") {
            if (base.kind !== "class" && base.kind !== "classRef") {
              this.error("SEM003", `Class '${fqcn}' cannot extend non-class '${typeName(base)}'`, decl.extends.span);
            } else {
              const baseInfo = this.typeInfoOf(base);
              if (baseInfo?.kind === "interface") {
                this.error("SEM003", `Class '${fqcn}' cannot extend interface '${baseInfo.fqcn}'`, decl.extends.span);
              } else {
                info.base = baseInfo?.fqcn ?? typeName(base);
                if (baseInfo?.flags.final) {
                  this.error("SEM010", `Cannot extend final class '${baseInfo.fqcn}'`, decl.extends.span);
                }
              }
            }
          }
        }

        for (const interfaceType of decl.implements) {
          const resolved = this.resolveType(interfaceType, ctx);
          if (resolved.kind === "unknown") continue;
          const interfaceInfo = this.typeInfoOf(resolved);
          if (!interfaceInfo || interfaceInfo.kind !== "interface") {
            this.error(
              "SEM006",
              `Class '${fqcn}' cannot implement non-interface '${typeName(resolved)}'`,
              interfaceType.span,
            );
          } else if (!info.interfaces.includes(interfaceInfo.fqcn)) {
            info.interfaces.push(interfaceInfo.fqcn);
          }
        }
      } else {
        for (const interfaceType of decl.extends) {
          const resolved = this.resolveType(interfaceType, ctx);
          if (resolved.kind === "unknown") continue;
          const interfaceInfo = this.typeInfoOf(resolved);
          if (!interfaceInfo || interfaceInfo.kind !== "interface") {
            this.error(
              "SEM004",
              `Interface '${fqcn}' cannot extend non-interface '${typeName(resolved)}'`,
              interfaceType.span,
            );
          } else if (!info.interfaces.includes(interfaceInfo.fqcn)) {
            info.interfaces.push(interfaceInfo.fqcn);
          }
        }
      }
    }
  }

  private checkInheritanceCycles(): void {
    const state = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];
    const reported = new Set<string>();

    const visit = (fqcn: string): void => {
      const current = state.get(fqcn) ?? 0;
      if (current === 2) return;
      if (current === 1) {
        const start = stack.indexOf(fqcn);
        const cycle = stack.slice(start);
        const key = [...cycle].sort().join("|");
        if (!reported.has(key)) {
          reported.add(key);
          const reference = this.sourceDecls.get(fqcn);
          const ordered = [...cycle, fqcn];
          this.error(
            "SEM005",
            `Inheritance cycle: ${ordered.join(" -> ")}`,
            reference?.decl.span ?? reference?.ctx.unit.program.span ?? fallbackSpan(),
          );
        }
        return;
      }

      state.set(fqcn, 1);
      stack.push(fqcn);
      const info = this.types.get(fqcn);
      if (info?.base && this.types.has(info.base)) visit(info.base);
      for (const interfaceType of info?.interfaces ?? []) {
        if (this.types.has(interfaceType)) visit(interfaceType);
      }
      stack.pop();
      state.set(fqcn, 2);
    };

    for (const fqcn of this.sourceTypes.keys()) visit(fqcn);
  }

  private checkOverrides(): void {
    for (const [fqcn, info] of this.sourceTypes) {
      if (info.kind !== "class") continue;
      if (this.hasExternalAncestor(info)) continue;
      for (const member of [...info.members, ...info.statics]) {
        if (member.kind === "field" || member.static) continue;

        const baseMember = this.findBaseMember(info, member.name, member.kind, member.static);
        const anyBaseMember = baseMember ?? this.findBaseMember(info, member.name, member.kind, !member.static);

        if (member.override) {
          if (!anyBaseMember) {
            this.error(
              "SEM008",
              `Member '${member.name}' in '${fqcn}' is marked override but no base member exists`,
              member.span,
            );
          } else if (!baseMember) {
            this.error(
              "SEM009",
              `Member '${member.name}' in '${fqcn}' changes static/instance kind from its base`,
              member.span,
            );
          } else if (baseMember.declaredIn === "Object") {
            // Object.toString/valueOf are runtime declarations; the corpus does not
            // consistently repeat `override` for these built-ins.
            continue;
          } else {
            if (baseMember.final) {
              this.error("SEM011", `Cannot override final member '${member.name}'`, member.span);
            }
            if (ACCESS_RANK[member.access] < ACCESS_RANK[baseMember.access]) {
              this.error(
                "SEM013",
                `Override '${member.name}' is less accessible than its base member`,
                member.span,
              );
            }
            const baseType = this.typeFromName(baseMember.type);
            const memberType = this.typeFromName(member.type);
            if (!this.isAssignable(memberType, baseType)) {
              this.checkAssignable(memberType, baseType, member.span, "Override return type");
            }
          }
        } else if (baseMember && baseMember.access !== "private") {
          if (baseMember.declaredIn === "Object") continue;
          this.error(
            "SEM008",
            `Member '${member.name}' in '${fqcn}' must be marked override`,
            member.span,
          );
        }
      }
    }
  }

  private checkImplementations(): void {
    for (const [fqcn, info] of this.sourceTypes) {
      if (info.kind !== "class") continue;
      for (const interfaceFqcn of this.allInterfaces(info)) {
        const interfaceInfo = this.types.get(interfaceFqcn);
        if (!interfaceInfo || interfaceInfo.origin !== "source") continue;

        for (const required of interfaceInfo.members) {
          if (required.static) continue;
          const implementation = this.findImplementation(info, required.name, required.kind);
          if (!implementation) {
            if (this.hasExternalAncestor(info)) continue;
            this.error(
              "SEM007",
              `Class '${fqcn}' does not implement '${required.name}' from ${interfaceFqcn}`,
              this.sourceDecls.get(fqcn)?.decl.span ?? fallbackSpan(),
              [`Required member kind: ${required.kind}`],
            );
            continue;
          }

          if (implementation.access !== "public") {
            this.error(
              "SEM013",
              `Interface member '${required.name}' must be implemented as public in '${fqcn}'`,
              implementation.span,
            );
          }

          this.checkSignature(implementation, required, fqcn);
        }
      }
    }
  }

  private checkSignature(implementation: MemberInfo, required: MemberInfo, owner: string): void {
    const requiredParams = required.params.filter((p) => !p.optional && !p.rest).length;
    const hasRest = implementation.params.some((p) => p.rest) || required.params.some((p) => p.rest);
    if (implementation.params.length < requiredParams || (!hasRest && implementation.params.length > required.params.length)) {
      this.error(
        "SEM015",
        `Signature mismatch for '${required.name}' in '${owner}'`,
        implementation.span,
        [`Expected ${required.params.length} parameter(s), found ${implementation.params.length}`],
      );
      return;
    }

    for (let index = 0; index < required.params.length; index += 1) {
      const expected = required.params[index];
      const actual = implementation.params[index];
      if (!expected || !actual) continue;
      const expectedType = this.typeFromName(expected.type);
      const actualType = this.typeFromName(actual.type);
      if (!this.isAssignable(expectedType, actualType) && !this.isAssignable(actualType, expectedType)) {
        this.error(
          "SEM015",
          `Parameter '${expected.name}' of '${required.name}' has incompatible type in '${owner}'`,
          implementation.span,
          [`Interface: ${expected.type}`, `Implementation: ${actual.type}`],
        );
      }
    }

    const expectedReturn = this.typeFromName(required.type);
    const actualReturn = this.typeFromName(implementation.type);
    if (!this.isAssignable(actualReturn, expectedReturn)) {
      this.error(
        "SEM015",
        `Return type of '${required.name}' is incompatible in '${owner}'`,
        implementation.span,
        [`Interface: ${required.type}`, `Implementation: ${implementation.type}`],
      );
    }
  }

  private checkDeclarationBodies(
    declaration: AST.ClassDeclaration | AST.InterfaceDeclaration,
    ctx: FileContext,
  ): void {
    const info = this.sourceTypes.get(qualifiedName(ctx.packageName, declaration.name));
    if (!info) return;

    for (const member of declaration.members) {
      if (member.kind === "NamespaceDeclaration") continue;

      if (member.kind === "FieldDeclaration") {
        const memberInfo = this.memberInfoByNode.get(member);
        if (!member.initializer) continue;
        const state: CheckState = {
          ctx,
          currentType: info,
          currentMember: memberInfo ?? null,
          inStatic: member.modifiers.includes("static"),
          returnType: "*",
          scope: new Scope(),
          functionScope: new Scope(),
          loopDepth: 0,
          switchDepth: 0,
          labels: new Set(),
        };
        const actual = this.checkExpression(member.initializer, state);
        if (memberInfo) this.checkAssignable(actual, this.typeFromName(memberInfo.type), member.initializer.span, "Field initializer");
        continue;
      }

      if (member.kind === "ClassInitializer") {
        const state: CheckState = {
          ctx,
          currentType: info,
          currentMember: null,
          inStatic: member.modifiers.includes("static"),
          returnType: "void",
          scope: new Scope(),
          functionScope: new Scope(),
          loopDepth: 0,
          switchDepth: 0,
          labels: new Set(),
        };
        this.hoistLocals(member.body, state);
        this.checkBlock(member.body, state);
        continue;
      }

      if (member.kind === "MethodDeclaration") {
        if (!member.body) continue;
        const memberInfo = this.memberInfoByNode.get(member);
        const scope = new Scope();
        member.params.forEach((param) => {
          const paramType = memberInfo?.params.find((p) => p.name === param.name)?.type ?? "*";
          scope.declare(param.name, this.typeFromName(paramType));
        });
        const state: CheckState = {
          ctx,
          currentType: info,
          currentMember: memberInfo ?? null,
          inStatic: member.modifiers.includes("static"),
          returnType: memberInfo?.kind === "setter" ? "void" : memberInfo?.type ?? "*",
          scope,
          functionScope: scope,
          loopDepth: 0,
          switchDepth: 0,
          labels: new Set(),
        };
        this.hoistLocals(member.body, state);
        this.checkBlock(member.body, state);
      }
    }
  }

  private checkBlock(block: AST.BlockStatement, state: CheckState): void {
    const inner: CheckState = { ...state, scope: new Scope(state.scope) };
    for (const statement of block.body) this.checkStatement(statement, inner);
  }

  /**
   * AS3 hoists local declarations to the enclosing function, so a closure declared
   * before a `var` may still reference it. Pre-declare the names with their annotated
   * type (or `*`); the VariableStatement pass later refines inferred types.
   */
  private hoistLocals(block: AST.BlockStatement, state: CheckState): void {
    const visit = (statement: AST.Statement): void => {
      switch (statement.kind) {
        case "BlockStatement":
          for (const child of statement.body) visit(child);
          return;
        case "VariableStatement":
          for (const declaration of statement.declarations) {
            if (state.functionScope.values.has(declaration.name)) continue;
            const type = declaration.type ? this.resolveType(declaration.type, state.ctx) : ANY;
            state.functionScope.declare(declaration.name, type, statement.isConst);
          }
          return;
        case "IfStatement":
          visit(statement.consequent);
          if (statement.alternate) visit(statement.alternate);
          return;
        case "WhileStatement":
        case "DoWhileStatement":
          visit(statement.body);
          return;
        case "ForStatement":
          if (Array.isArray(statement.init)) {
            for (const declaration of statement.init) {
              if (state.functionScope.values.has(declaration.name)) continue;
              const type = declaration.type ? this.resolveType(declaration.type, state.ctx) : ANY;
              state.functionScope.declare(declaration.name, type);
            }
          }
          visit(statement.body);
          return;
        case "ForInStatement":
          if (statement.declaration && !state.functionScope.values.has(statement.declaration.name)) {
            const type = statement.declaration.type
              ? this.resolveType(statement.declaration.type, state.ctx)
              : ANY;
            state.functionScope.declare(statement.declaration.name, type);
          }
          visit(statement.body);
          return;
        case "SwitchStatement":
          for (const switchCase of statement.cases) {
            for (const child of switchCase.statements) visit(child);
          }
          return;
        case "TryStatement":
          visit(statement.block);
          for (const clause of statement.catches) visit(clause.block);
          if (statement.finalizer) visit(statement.finalizer);
          return;
        case "LabeledStatement":
          visit(statement.statement);
          return;
        default:
          return;
      }
    };
    visit(block);
  }

  private checkStatement(statement: AST.Statement, state: CheckState): void {
    switch (statement.kind) {
      case "BlockStatement":
        this.checkBlock(statement, state);
        return;
      case "VariableStatement":
        for (const declaration of statement.declarations) {
          const declaredType = declaration.type ? this.resolveType(declaration.type, state.ctx) : ANY;
          let type = declaredType;
          if (declaration.initializer) {
            const actual = this.checkExpression(declaration.initializer, state);
            if (declaration.type) {
              this.checkAssignable(actual, declaredType, declaration.initializer.span, "Variable initializer");
            } else {
              type = actual;
            }
          }
          state.functionScope.declare(declaration.name, type, statement.isConst);
        }
        return;
      case "EmptyStatement":
        return;
      case "ExpressionStatement":
        this.checkExpression(statement.expression, state);
        return;
      case "IfStatement":
        this.checkExpression(statement.test, state);
        this.checkStatement(statement.consequent, state);
        if (statement.alternate) this.checkStatement(statement.alternate, state);
        return;
      case "WhileStatement":
        this.checkExpression(statement.test, state);
        this.checkStatement(statement.body, { ...state, loopDepth: state.loopDepth + 1 });
        return;
      case "DoWhileStatement":
        this.checkStatement(statement.body, { ...state, loopDepth: state.loopDepth + 1 });
        this.checkExpression(statement.test, state);
        return;
      case "ForStatement": {
        const inner: CheckState = { ...state, scope: new Scope(state.scope), loopDepth: state.loopDepth + 1 };
        if (Array.isArray(statement.init)) {
          for (const declaration of statement.init) {
            const declaredType = declaration.type ? this.resolveType(declaration.type, state.ctx) : ANY;
            const actual = declaration.initializer ? this.checkExpression(declaration.initializer, inner) : ANY;
            inner.functionScope.declare(declaration.name, declaration.type ? declaredType : actual);
          }
        } else if (statement.init) {
          this.checkExpression(statement.init, inner);
        }
        if (statement.test) this.checkExpression(statement.test, inner);
        if (statement.update) this.checkExpression(statement.update, inner);
        this.checkStatement(statement.body, inner);
        return;
      }
      case "ForInStatement": {
        const inner: CheckState = { ...state, scope: new Scope(state.scope), loopDepth: state.loopDepth + 1 };
        if (statement.declaration) {
          const declaredType = statement.declaration.type
            ? this.resolveType(statement.declaration.type, state.ctx)
            : ANY;
          inner.functionScope.declare(statement.declaration.name, declaredType);
        } else {
          this.checkExpression(statement.target, inner);
        }
        this.checkExpression(statement.iterable, inner);
        this.checkStatement(statement.body, inner);
        return;
      }
      case "SwitchStatement": {
        this.checkExpression(statement.discriminant, state);
        const inner: CheckState = { ...state, switchDepth: state.switchDepth + 1 };
        for (const switchCase of statement.cases) {
          if (switchCase.test) this.checkExpression(switchCase.test, inner);
          for (const child of switchCase.statements) this.checkStatement(child, inner);
        }
        return;
      }
      case "TryStatement": {
        this.checkBlock(statement.block, state);
        for (const catchClause of statement.catches) {
          const inner: CheckState = { ...state, scope: new Scope(state.scope) };
          const type = catchClause.type ? this.resolveType(catchClause.type, state.ctx) : ANY;
          inner.scope.declare(catchClause.name, type);
          this.checkBlock(catchClause.block, inner);
        }
        if (statement.finalizer) this.checkBlock(statement.finalizer, state);
        return;
      }
      case "ThrowStatement":
        this.checkExpression(statement.expression, state);
        return;
      case "ReturnStatement":
        this.checkReturn(statement, state);
        return;
      case "BreakStatement":
        if (statement.label && !state.labels.has(statement.label)) {
          this.error("SEM027", `Unknown break label '${statement.label}'`, statement.span);
        } else if (!statement.label && state.loopDepth === 0 && state.switchDepth === 0) {
          this.error("SEM027", `break is not inside a loop or switch`, statement.span);
        }
        return;
      case "ContinueStatement":
        if (statement.label && !state.labels.has(statement.label)) {
          this.error("SEM027", `Unknown continue label '${statement.label}'`, statement.span);
        } else if (!statement.label && state.loopDepth === 0) {
          this.error("SEM027", `continue is not inside a loop`, statement.span);
        }
        return;
      case "LabeledStatement":
        this.checkStatement(statement.statement, {
          ...state,
          labels: new Set([...state.labels, statement.label]),
        });
        return;
      case "FunctionDeclarationStatement": {
        const functionType: SemanticType = { kind: "function", name: "Function" };
        state.scope.declare(statement.declaration.name, functionType);
        if (statement.declaration.body) {
          const scope = new Scope(state.scope);
          for (const param of statement.declaration.params) {
            scope.declare(param.name, param.type ? this.typeFromName(this.typeNameOf(this.resolveType(param.type, state.ctx))) : ANY);
          }
          this.checkBlock(statement.declaration.body, {
            ...state,
            scope,
            functionScope: scope,
            currentMember: null,
            returnType: statement.declaration.returnType
              ? this.typeNameOf(this.resolveType(statement.declaration.returnType, state.ctx))
              : "*",
          });
        }
        return;
      }
      case "WithStatement":
        this.checkExpression(statement.object, state);
        // Members of the with object are dynamically scoped; the lowerer resolves
        // unresolved identifiers to that object. Keep the body checked for its
        // explicit locals, calls and control flow.
        this.checkStatement(statement.body, state);
        return;
    }
  }

  private checkReturn(statement: AST.ReturnStatement, state: CheckState): void {
    const expected = this.typeFromName(state.returnType);
    if (!statement.expression) {
      if (expected.kind !== "void" && expected.kind !== "any" && expected.kind !== "unknown") {
        this.error("SEM017", `Missing return value; expected '${state.returnType}'`, statement.span);
      }
      return;
    }

    const actual = this.checkExpression(statement.expression, state);
    if (expected.kind === "void") return;
    this.checkAssignable(actual, expected, statement.expression.span, "Return value");
  }

  private checkExpression(expression: AST.Expression, state: CheckState): SemanticType {
    switch (expression.kind) {
      case "Identifier":
        return this.resolveValue(expression.name, state, expression.span);
      case "ThisExpression":
        if (state.inStatic) this.error("SEM022", "`this` is not available in a static member", expression.span);
        return this.typeFromInfo(state.currentType);
      case "SuperExpression":
        if (state.inStatic) this.error("SEM023", "`super` is not available in a static member", expression.span);
        if (!state.currentType.base) {
          this.error("SEM023", "`super` is not available without a base class", expression.span);
          return ANY;
        }
        return this.typeFromName(state.currentType.base);
      case "Literal":
        return this.literalType(expression);
      case "ArrayLiteral":
        for (const element of expression.elements) if (element) this.checkExpression(element, state);
        return this.typeFromName("Array");
      case "TypedArrayExpression": {
        const elementType = this.resolveType(expression.elementType, state.ctx);
        for (const element of expression.elements) {
          if (!element) continue;
          const actual = this.checkExpression(element, state);
          this.checkAssignable(actual, elementType, element.span, "Typed array element");
        }
        // `new <T>[...]` is a Vector literal: the corpus assigns these directly to
        // `Vector.<T>` fields and constants.
        return vectorType(elementType);
      }
      case "ObjectLiteral":
        for (const property of expression.properties) this.checkExpression(property.value, state);
        return this.typeFromName("Object");
      case "FunctionExpression": {
        const scope = new Scope(state.scope);
        for (const param of expression.params) {
          scope.declare(param.name, param.type ? this.resolveType(param.type, state.ctx) : ANY);
        }
        const returnType = expression.returnType
          ? this.typeNameOf(this.resolveType(expression.returnType, state.ctx))
          : "*";
        const inner: CheckState = { ...state, scope, functionScope: scope, returnType, currentMember: null };
        this.hoistLocals(expression.body, inner);
        this.checkBlock(expression.body, inner);
        return FUNCTION;
      }
      case "NewExpression":
        return this.checkNew(expression, state);
      case "CallExpression":
        return this.checkCall(expression, state);
      case "MemberExpression":
        return this.memberAccess(expression, state).type;
      case "XmlFilterExpression":
        this.checkExpression(expression.object, state);
        this.checkExpression(expression.predicate, state);
        return this.typeFromName("XMLList");
      case "UnaryExpression":
        return this.checkUnary(expression, state);
      case "BinaryExpression":
        return this.checkBinary(expression, state);
      case "ConditionalExpression": {
        this.checkExpression(expression.test, state);
        const consequent = this.checkExpression(expression.consequent, state);
        const alternate = this.checkExpression(expression.alternate, state);
        return this.commonType(consequent, alternate);
      }
      case "AssignmentExpression": {
        const left = this.checkExpression(expression.left, state);
        const right = this.checkExpression(expression.right, state);
        this.checkAssignable(right, left, expression.right.span, "Assignment");
        this.checkAssignmentTarget(expression.left, state);
        return left;
      }
      case "TypeTestExpression": {
        this.checkExpression(expression.expression, state);
        const target = this.resolveType(expression.type, state.ctx);
        return expression.operator === "is" ? BOOLEAN : target;
      }
      case "SequenceExpression": {
        let last: SemanticType = ANY;
        for (const child of expression.expressions) last = this.checkExpression(child, state);
        return last;
      }
      case "ParenthesizedExpression":
        return this.checkExpression(expression.expression, state);
      case "VectorTypeExpression":
        return vectorType(this.resolveType(expression.element, state.ctx));
      case "QualifiedNameExpression": {
        const member = this.findMember(state.currentType, expression.name, state.inStatic, expression.namespace);
        return member ? this.memberValueType(member) : ANY;
      }
      case "AttributeSelectorExpression":
        return ANY;
    }
  }

  private checkNew(expression: AST.NewExpression, state: CheckState): SemanticType {
    if (expression.target.kind === "VectorTypeExpression") {
      const type = vectorType(this.resolveType(expression.target.element, state.ctx));
      for (const argument of expression.args) this.checkExpression(argument, state);
      return type;
    }

    const target = this.checkExpression(expression.target, state);
    if (target.kind === "function" && target.name === "Function") {
      for (const argument of expression.args) this.checkExpression(argument, state);
      return FUNCTION;
    }
    if (target.kind === "class" && target.name === "Class") {
      for (const argument of expression.args) this.checkExpression(argument, state);
      return ANY;
    }
    const info = this.typeInfoOf(target);
    if (target.kind !== "class" && target.kind !== "classRef" && target.kind !== "interface") {
      if (target.kind !== "any" && target.kind !== "unknown") {
        this.error("SEM026", `'new' target '${typeName(target)}' is not a class`, expression.target.span);
      }
      return ANY;
    }
    if (info?.origin === "source") {
      const constructor = info.constructors[0];
      if (constructor) {
        this.checkArguments(constructor, expression.args, state, expression.span);
      } else if (expression.args.length > 0) {
        this.error(
          "SEM025",
          `Class '${info.fqcn}' has no constructor accepting arguments`,
          expression.span,
        );
      }
    }
    return info ? this.typeFromInfo(info) : target;
  }

  private checkCall(expression: AST.CallExpression, state: CheckState): SemanticType {
    if (expression.callee.kind === "MemberExpression") {
      const lookup = this.memberAccess(expression.callee, state);
      if (lookup.member) this.checkArguments(lookup.member, expression.args, state, expression.span);
      return lookup.member ? this.memberValueType(lookup.member) : ANY;
    }

    if (expression.callee.kind === "VectorTypeExpression") {
      for (const argument of expression.args) this.checkExpression(argument, state);
      return vectorType(this.resolveType(expression.callee.element, state.ctx));
    }

    if (expression.callee.kind === "Identifier" && PRIMITIVE_TYPES.has(expression.callee.name)) {
      for (const argument of expression.args) this.checkExpression(argument, state);
      return this.typeFromName(expression.callee.name);
    }

    if (expression.callee.kind === "SuperExpression") {
      for (const argument of expression.args) this.checkExpression(argument, state);
      return VOID;
    }

    const callee = this.checkExpression(expression.callee, state);
    if (callee.kind === "classRef" || callee.kind === "class" || callee.kind === "interface") {
      for (const argument of expression.args) this.checkExpression(argument, state);
      const info = this.typeInfoOf(callee);
      // `Foo(value)` is an AS3 cast/conversion and yields an instance, not the class object.
      return info ? this.typeFromInfo(info) : ANY;
    }
    if (callee.kind !== "function" && callee.kind !== "any" && callee.kind !== "unknown") {
      this.error("SEM016", `Expression of type '${typeName(callee)}' is not callable`, expression.callee.span);
    }
    for (const argument of expression.args) this.checkExpression(argument, state);
    return ANY;
  }

  private checkUnary(expression: AST.UnaryExpression, state: CheckState): SemanticType {
    const operand = this.checkExpression(expression.operand, state);
    if (expression.operator === "typeof") return STRING;
    if (expression.operator === "delete") return BOOLEAN;
    if (expression.operator === "void") return VOID;
    if (expression.operator === "!") return BOOLEAN;
    if (expression.operator === "++" || expression.operator === "--") {
      this.checkAssignmentTarget(expression.operand, state);
      return operand.kind === "primitive" && NUMERIC.has(operand.name) ? operand : NUMBER;
    }
    if (expression.operator === "~") return INT;
    return NUMBER;
  }

  private checkBinary(expression: AST.BinaryExpression, state: CheckState): SemanticType {
    const left = this.checkExpression(expression.left, state);
    const right = this.checkExpression(expression.right, state);
    const operator = expression.operator;
    if (["==", "!=", "===", "!==", "<", ">", "<=", ">=", "in", "instanceof"].includes(operator)) {
      return BOOLEAN;
    }
    if (operator === "&&" || operator === "||") return this.commonType(left, right);
    if (operator === "+") {
      if (left.name === "String" || right.name === "String") return STRING;
      if (left.name === "int" && right.name === "int") return INT;
      return NUMBER;
    }
    if (["&", "|", "^", "<<", ">>", ">>>"].includes(operator)) return INT;
    return NUMBER;
  }

  private memberAccess(expression: AST.MemberExpression, state: CheckState): MemberLookup {
    const objectType = this.checkExpression(expression.object, state);
    if (expression.access === "attribute" || expression.access === "descendant" || expression.access === "wildcard") {
      return { member: null, type: ANY };
    }

    if (expression.computed) {
      if (expression.property && typeof expression.property !== "string") {
        this.checkExpression(expression.property, state);
      }
      if (objectType.kind === "vector") return { member: null, type: objectType.element ?? ANY };
      if (objectType.name === "Array") return { member: null, type: ANY };
      return { member: null, type: ANY };
    }

    if (typeof expression.property !== "string") return { member: null, type: ANY };
    const info = this.typeInfoOf(objectType);
    if (!info) return { member: null, type: ANY };

    const isStatic = objectType.kind === "classRef";
    const member = this.findMember(info, expression.property, isStatic, expression.namespace);
    if (!member) {
      if (info.origin === "runtime" && !DYNAMIC_RUNTIME_TYPES.has(info.fqcn)) {
        this.recordRuntimeMemberUse(info.fqcn, expression.property, expression.span);
      }
      if (
        info.origin !== "source" ||
        info.flags.dynamic ||
        this.hasExternalAncestor(info)
      ) return { member: null, type: ANY };
      this.error(
        "SEM024",
        `Type '${info.fqcn}' has no member '${expression.property}'`,
        expression.span,
      );
      return { member: null, type: ANY };
    }

    if (!this.canAccess(member, state)) {
      this.error(
        "SEM013",
        `Member '${expression.property}' of '${info.fqcn}' is not accessible here`,
        expression.span,
      );
    }
    return {
      member,
      type: member.kind === "method" ? FUNCTION : this.memberValueType(member),
    };
  }

  private recordRuntimeMemberUse(
    fqcn: string,
    member: string,
    span: import("../diagnostics.ts").Span,
  ): void {
    const key = `${fqcn}.${member}`;
    const existing = this.runtimeMemberUses.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.runtimeMemberUses.set(key, { fqcn, member, count: 1, file: span.file, line: span.line });
  }

  private resolveValue(name: string, state: CheckState, at: Span): SemanticType {
    const local = state.scope.lookup(name);
    if (local) return local.type;

    let member = this.findMember(state.currentType, name, state.inStatic, null);
    if (!member && !state.inStatic) {
      member = this.findMember(state.currentType, name, true, null);
    }
    if (member) {
      if (!this.canAccess(member, state)) {
        this.error("SEM013", `Member '${name}' is not accessible here`, at);
      }
      return member.kind === "method" ? FUNCTION : this.memberValueType(member);
    }

    const typeInfo = this.lookupTypeInfo(name, state.ctx);
    if (typeInfo) return classReference(typeInfo);

    const imported = this.resolveImportedValue(name, state.ctx);
    if (imported) return imported;

    if (name === "NaN" || name === "Infinity") return NUMBER;
    if (name === "undefined") return { kind: "undefined", name: "undefined" };
    if (GLOBAL_FUNCTIONS.has(name)) return FUNCTION;
    if (name === "Math" || name === "JSON") {
      const info = this.types.get(name);
      if (info) return classReference(info);
    }
    if (PRIMITIVE_TYPES.has(name)) return FUNCTION;
    if (this.packageRoots.has(name)) return ANY;
    if (this.hasExternalAncestor(state.currentType)) return ANY;

    this.warning("SEM014", `Cannot resolve identifier '${name}'; treating it as dynamic`, at);
    return ANY;
  }

  private resolveImportedValue(name: string, ctx: FileContext): SemanticType | null {
    const explicit = ctx.explicitImports.get(name);
    if (explicit) {
      if (this.runtimeValues.has(explicit)) return FUNCTION;
      if (this.runtimeNamespaces.has(explicit)) return ANY;
      const info = this.types.get(explicit);
      if (info) return classReference(info);
    }

    for (const packageName of ctx.wildcardImports) {
      const fqcn = packageName ? `${packageName}.${name}` : name;
      if (this.runtimeValues.has(fqcn)) return FUNCTION;
      const info = this.types.get(fqcn);
      if (info) return classReference(info);
    }
    return null;
  }

  private literalType(expression: AST.LiteralExpression): SemanticType {
    switch (expression.literalKind) {
      case "number":
        return NUMBER;
      case "string":
        return STRING;
      case "boolean":
        return BOOLEAN;
      case "null":
        return { kind: "null", name: "null" };
      case "undefined":
        return { kind: "undefined", name: "undefined" };
      case "regex":
        return this.typeFromName("RegExp");
      case "xml":
        return XML;
    }
  }

  private resolveType(node: AST.TypeNode, ctx: FileContext): SemanticType {
    const cached = this.typeNodeCache.get(node);
    if (cached) return cached;

    let result: SemanticType;
    switch (node.kind) {
      case "WildcardType":
        result = ANY;
        break;
      case "VectorType": {
        const element = this.resolveType(node.element, ctx);
        result = vectorType(element);
        break;
      }
      case "NamedType":
        result = this.resolveNamedType(node.name, ctx, node.span);
        break;
    }
    this.typeNodeCache.set(node, result);
    return result;
  }

  private resolveNamedType(name: string, ctx: FileContext, at: Span): SemanticType {
    const info = this.lookupTypeInfo(name, ctx);
    if (info) return this.typeFromInfo(info);

    if (PRIMITIVE_TYPES.has(name)) return PRIMITIVE_TYPES.get(name)!;
    if (name === "*") return ANY;
    if (name === "Function") return FUNCTION;

    this.unresolvedType(name, at);
    return UNKNOWN;
  }

  private lookupTypeInfo(name: string, ctx: FileContext): TypeInfo | null {
    if (PRIMITIVE_NAMES.has(name) || name === "*" || name === "Function") return null;

    const direct = this.types.get(name);
    if (direct) return direct;

    if (!name.includes(".")) {
      const local = this.types.get(qualifiedName(ctx.packageName, name));
      if (local) return local;

      const explicit = ctx.explicitImports.get(name);
      if (explicit) {
        const info = this.types.get(explicit);
        if (info) return info;
      }

      const wildcardCandidates = new Set<string>();
      for (const packageName of ctx.wildcardImports) {
        const fqcn = packageName ? `${packageName}.${name}` : name;
        if (this.types.has(fqcn)) wildcardCandidates.add(fqcn);
      }
      if (wildcardCandidates.size === 1) {
        return this.types.get([...wildcardCandidates][0]!) ?? null;
      }
      return null;
    }

    return null;
  }

  private unresolvedType(name: string, at: Span): void {
    const key = `${at.file}:${at.start}:${name}`;
    if (this.unresolvedTypeKeys.has(key)) return;
    this.unresolvedTypeKeys.add(key);
    this.error("SEM002", `Cannot resolve type '${name}'`, at);
  }

  private typeFromInfo(info: TypeInfo): SemanticType {
    return {
      kind: info.kind,
      name: info.fqcn,
      fqcn: info.fqcn,
      external: info.flags.external,
    };
  }

  private typeInfoOf(type: SemanticType): TypeInfo | null {
    if (type.kind !== "class" && type.kind !== "interface" && type.kind !== "classRef") return null;
    return this.types.get(type.fqcn ?? type.name) ?? null;
  }

  private typeFromName(name: string): SemanticType {
    if (name === "*" || name === "any") return ANY;
    if (name === "void") return VOID;
    if (name === "unknown") return UNKNOWN;
    if (name === "null") return { kind: "null", name: "null" };
    if (name === "undefined") return { kind: "undefined", name: "undefined" };
    if (name === "Function") return FUNCTION;
    if (PRIMITIVE_TYPES.has(name)) return PRIMITIVE_TYPES.get(name)!;
    if (name.startsWith("Vector.<") && name.endsWith(">")) {
      return vectorType(this.typeFromName(name.slice("Vector.<".length, -1)));
    }
    const info = this.types.get(name);
    return info ? this.typeFromInfo(info) : UNKNOWN;
  }

  private typeNameOf(type: SemanticType): string {
    return typeName(type);
  }

  private findMember(
    info: TypeInfo,
    name: string,
    isStatic: boolean,
    namespace: string | null,
  ): MemberInfo | null {
    let current: TypeInfo | undefined = info;
    const seen = new Set<string>();
    while (current && !seen.has(current.fqcn)) {
      seen.add(current.fqcn);
      const list = isStatic ? current.statics : current.members;
      const matches = list.filter((member) =>
        member.name === name && (namespace === null || member.namespace === namespace),
      );
      if (matches.length > 0) {
        return (
          matches.find((member) => member.kind === "getter") ??
          matches.find((member) => member.kind === "field") ??
          matches.find((member) => member.kind === "method") ??
          matches[0]!
        );
      }
      if (!isStatic) {
        for (const interfaceFqcn of current.interfaces) {
          const interfaceInfo = this.types.get(interfaceFqcn);
          if (!interfaceInfo) continue;
          const found = this.findMember(interfaceInfo, name, false, namespace);
          if (found) return found;
        }
      }
      current = current.base ? this.types.get(current.base) : undefined;
    }
    return null;
  }

  private findBaseMember(
    info: TypeInfo,
    name: string,
    kind: MemberKind,
    isStatic: boolean,
  ): MemberInfo | null {
    let current = info.base ? this.types.get(info.base) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.fqcn)) {
      seen.add(current.fqcn);
      const list = isStatic ? current.statics : current.members;
      const found = list.find((member) => member.name === name && member.kind === kind);
      if (found) return found;
      current = current.base ? this.types.get(current.base) : undefined;
    }
    return null;
  }

  private findImplementation(info: TypeInfo, name: string, kind: MemberKind): MemberInfo | null {
    let current: TypeInfo | undefined = info;
    const seen = new Set<string>();
    while (current && !seen.has(current.fqcn)) {
      seen.add(current.fqcn);
      const found = current.members.find((member) => member.name === name && member.kind === kind);
      if (found) return found;
      current = current.base ? this.types.get(current.base) : undefined;
    }
    return null;
  }

  private memberValueType(member: MemberInfo): SemanticType {
    if (member.kind === "setter" && member.params[0]) return this.typeFromName(member.params[0].type);
    return this.typeFromName(member.type);
  }

  private canAccess(member: MemberInfo, state: CheckState): boolean {
    if (member.access === "public") return true;
    if (member.access === "private") return member.declaredIn === state.currentType.fqcn;
    const owner = this.types.get(member.declaredIn);
    if (!owner) return true;
    if (member.access === "internal") return owner.packageName === state.currentType.packageName;
    if (member.access === "protected") return this.isSubclass(state.currentType, member.declaredIn);
    if (member.access === "custom") {
      return owner.packageName === state.currentType.packageName || state.ctx.namespaces.has(member.namespace);
    }
    return false;
  }

  private collectPackageRoots(): void {
    for (const info of this.types.values()) {
      if (info.fqcn.includes(".")) this.packageRoots.add(info.fqcn.split(".")[0]!);
    }
  }

  private hasExternalAncestor(info: TypeInfo): boolean {
    const seen = new Set<string>();
    const visit = (current: TypeInfo | undefined): boolean => {
      if (!current || seen.has(current.fqcn)) return false;
      seen.add(current.fqcn);
      if (current.origin !== "source" && current.fqcn !== "Object") return true;
      for (const interfaceFqcn of current.interfaces) {
        if (visit(this.types.get(interfaceFqcn))) return true;
      }
      return visit(current.base ? this.types.get(current.base) : undefined);
    };
    return visit(info.base ? this.types.get(info.base) : undefined) ||
      info.interfaces.some((interfaceFqcn) => visit(this.types.get(interfaceFqcn)));
  }

  private isSubclass(info: TypeInfo, targetFqcn: string): boolean {
    if (info.fqcn === targetFqcn) return true;
    let current = info.base ? this.types.get(info.base) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.fqcn)) {
      if (current.fqcn === targetFqcn) return true;
      seen.add(current.fqcn);
      current = current.base ? this.types.get(current.base) : undefined;
    }
    return false;
  }

  private allInterfaces(info: TypeInfo): string[] {
    const found = new Set<string>();
    const visited = new Set<string>();
    const add = (current: TypeInfo | undefined): void => {
      if (!current || visited.has(current.fqcn)) return;
      visited.add(current.fqcn);
      for (const interfaceFqcn of current.interfaces) {
        found.add(interfaceFqcn);
        add(this.types.get(interfaceFqcn));
      }
      if (current.base) add(this.types.get(current.base));
    };
    add(info);
    return [...found].sort();
  }

  private checkArguments(
    member: MemberInfo,
    args: readonly AST.Expression[],
    state: CheckState,
    at: Span,
  ): void {
    const owner = this.types.get(member.declaredIn);
    if (owner?.origin !== "source") {
      for (const argument of args) this.checkExpression(argument, state);
      return;
    }

    if (member.kind !== "method") {
      for (const argument of args) this.checkExpression(argument, state);
      return;
    }

    const required = member.params.filter((param) => !param.optional && !param.rest).length;
    const hasRest = member.params.some((param) => param.rest);
    if (args.length < required || (!hasRest && args.length > member.params.length)) {
      this.error(
        "SEM025",
        `Wrong argument count for '${member.name}': expected ${required === member.params.length ? `${required}` : `${required}-${member.params.length}`}, got ${args.length}`,
        at,
      );
    }

    args.forEach((argument, index) => {
      const param = member.params[index] ?? member.params.find((candidate) => candidate.rest);
      const actual = this.checkExpression(argument, state);
      if (param) this.checkAssignable(actual, this.typeFromName(param.type), argument.span, `Argument ${index + 1}`);
    });
  }

  private checkAssignmentTarget(expression: AST.Expression, state: CheckState): void {
    if (expression.kind === "Identifier") {
      const binding = state.scope.lookup(expression.name);
      if (binding?.const) {
        this.error("SEM024", `Cannot assign to const '${expression.name}'`, expression.span);
        return;
      }
      const member = this.findMember(state.currentType, expression.name, state.inStatic, null);
      if (member?.isConst) {
        this.error("SEM024", `Cannot assign to readonly member '${expression.name}'`, expression.span);
      }
      return;
    }

    if (expression.kind === "MemberExpression" && typeof expression.property === "string" && !expression.computed) {
      const objectType = this.checkExpression(expression.object, state);
      const info = this.typeInfoOf(objectType);
      if (info) {
        const member = this.findMember(
          info,
          expression.property,
          objectType.kind === "classRef",
          expression.namespace,
        );
        if (member?.isConst) {
          this.error("SEM024", `Cannot assign to readonly member '${expression.property}'`, expression.span);
        }
      }
    }
  }

  private checkAssignable(
    from: SemanticType,
    to: SemanticType,
    at: Span,
    context: string,
  ): boolean {
    if (this.isAssignable(from, to)) return true;
    this.error(
      "SEM015",
      `${context}: cannot assign '${typeName(from)}' to '${typeName(to)}'`,
      at,
    );
    return false;
  }

  private isAssignable(from: SemanticType, to: SemanticType): boolean {
    if (from.kind === "any" || to.kind === "any" || from.kind === "unknown" || to.kind === "unknown") {
      return true;
    }
    if (from.kind === "void" || to.kind === "void") return from.kind === to.kind;
    if (typeName(from) === typeName(to)) return true;
    if (from.kind === "null" || from.kind === "undefined") return true;
    if (to.name === "Object") return true;
    if (from.kind === "primitive" && to.kind === "primitive") return true;
    if (to.kind === "primitive") return true;
    if (from.kind === "class" || from.kind === "interface") {
      if (to.kind === "class" || to.kind === "interface") return this.isSubtype(from, to);
    }
    if (from.kind === "classRef") {
      return to.kind === "classRef" || to.name === "Class" || to.name === "Object";
    }
    if (from.kind === "class" && from.name === "Class") return true;
    if (from.kind === "vector" && to.kind === "vector") {
      return this.isAssignable(from.element ?? ANY, to.element ?? ANY);
    }
    if (from.kind === "function") return to.kind === "function" || to.name === "Function" || to.name === "Object";
    if (NUMERIC.has(from.name) && (to.kind === "class" || to.kind === "interface")) return to.name === "Object";
    return false;
  }

  private isSubtype(from: SemanticType, to: SemanticType): boolean {
    const fromInfo = this.typeInfoOf(from);
    const toInfo = this.typeInfoOf(to);
    if (!fromInfo) return false;
    if (!toInfo) return to.name === "Object";

    if (fromInfo.fqcn === toInfo.fqcn) return true;
    if (toInfo.fqcn === "Object") return true;
    if (this.isSubclass(fromInfo, toInfo.fqcn)) return true;
    if (toInfo.kind === "interface") {
      return this.allInterfaces(fromInfo).includes(toInfo.fqcn);
    }
    return false;
  }

  private commonType(a: SemanticType, b: SemanticType): SemanticType {
    if (typeName(a) === typeName(b)) return a;
    if (this.isAssignable(a, b)) return b;
    if (this.isAssignable(b, a)) return a;
    return ANY;
  }

  private buildClassInitGraph(): ClassInitGraph {
    const edges: ClassInitEdge[] = [];
    const adjacency = new Map<string, Set<string>>();
    for (const fqcn of this.sourceTypes.keys()) adjacency.set(fqcn, new Set());

    for (const [fqcn, reference] of this.sourceDecls) {
      const info = this.sourceTypes.get(fqcn);
      if (!info || info.kind !== "class") continue;
      const dependencies = new Set<string>();
      for (const member of reference.decl.members) {
        if (
          member.kind === "FieldDeclaration" &&
          member.modifiers.includes("static") &&
          member.initializer
        ) {
          this.collectTypeDependencies(member.initializer, reference.ctx, dependencies);
        }
        if (
          member.kind === "ClassInitializer" &&
          member.modifiers.includes("static")
        ) {
          this.collectTypeDependencies(member.body, reference.ctx, dependencies);
        }
      }

      for (const dependency of dependencies) {
        if (!this.sourceTypes.has(dependency)) continue;
        adjacency.get(fqcn)?.add(dependency);
        edges.push({ from: fqcn, to: dependency });
      }
    }

    edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const cycles = this.findCycles(adjacency);
    for (const cycle of cycles) {
      const reference = this.sourceDecls.get(cycle[0]!);
      this.warning(
        "SEM021",
        `Class-initialization cycle: ${[...cycle, cycle[0]].join(" -> ")}`,
        reference?.decl.span ?? fallbackSpan(),
      );
    }

    return { edges, cycles };
  }

  private collectTypeDependencies(node: unknown, ctx: FileContext, out: Set<string>): void {
    if (Array.isArray(node)) {
      for (const child of node) this.collectTypeDependencies(child, ctx, out);
      return;
    }
    if (!node || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    if (record.kind === "Identifier" && typeof record.name === "string") {
      const info = this.lookupTypeInfo(record.name, ctx);
      if (info?.origin === "source") out.add(info.fqcn);
    }
    if (record.kind === "NamedType" && typeof record.name === "string") {
      const info = this.lookupTypeInfo(record.name, ctx);
      if (info?.origin === "source") out.add(info.fqcn);
    }

    for (const [key, value] of Object.entries(record)) {
      if (key === "span") continue;
      this.collectTypeDependencies(value, ctx, out);
    }
  }

  private findCycles(adjacency: Map<string, Set<string>>): string[][] {
    let index = 0;
    const indices = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const cycles: string[][] = [];

    const visit = (node: string): void => {
      indices.set(node, index);
      low.set(node, index);
      index += 1;
      stack.push(node);
      onStack.add(node);

      for (const next of [...(adjacency.get(node) ?? [])].sort()) {
        if (!indices.has(next)) {
          visit(next);
          low.set(node, Math.min(low.get(node)!, low.get(next)!));
        } else if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node)!, indices.get(next)!));
        }
      }

      if (low.get(node) === indices.get(node)) {
        const component: string[] = [];
        while (stack.length > 0) {
          const current = stack.pop()!;
          onStack.delete(current);
          component.push(current);
          if (current === node) break;
        }
        const selfEdge = adjacency.get(component[0]!)?.has(component[0]!) ?? false;
        if (component.length > 1 || selfEdge) cycles.push(component.sort());
      }
    };

    for (const node of [...adjacency.keys()].sort()) {
      if (!indices.has(node)) visit(node);
    }
    return cycles.sort((a, b) => a.join("|").localeCompare(b.join("|")));
  }

  private error(code: string, message: string, at: Span, notes?: string[]): void {
    this.diagnostics.push(diag("error", code, message, at, notes));
  }

  private warning(code: string, message: string, at: Span, notes?: string[]): void {
    this.diagnostics.push(diag("warning", code, message, at, notes));
  }
}

export function analyzeProject(
  units: readonly SourceUnit[],
  options: AnalyzeOptions = {},
): SemanticResult {
  return new SemanticAnalyzer(units, options).analyze();
}

export function analyzeSource(
  source: string,
  file = "<source>.as",
  options: AnalyzeOptions = {},
): SemanticResult {
  const parsed = parseSource(source, file);
  return analyzeProject(
    [{ file, program: parsed.program, diagnostics: parsed.diagnostics }],
    options,
  );
}

function qualifiedName(packageName: string, name: string): string {
  return packageName ? `${packageName}.${name}` : name;
}

function simpleName(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function vectorType(element: SemanticType): SemanticType {
  return { kind: "vector", name: `Vector.<${typeName(element)}>`, element };
}

function classReference(info: TypeInfo): SemanticType {
  return { kind: "classRef", name: info.fqcn, fqcn: info.fqcn, external: info.flags.external };
}

function typeName(type: SemanticType): string {
  if (type.kind === "vector" && type.element) return `Vector.<${typeName(type.element)}>`;
  return type.name;
}

function isAccessor(kind: MemberKind): boolean {
  return kind === "getter" || kind === "setter";
}

function accessKind(
  modifiers: readonly string[],
  namespace: string | null,
  isInterface: boolean,
): MemberInfo["access"] {
  if (namespace) return "custom";
  if (isInterface) return "public";
  if (modifiers.includes("private")) return "private";
  if (modifiers.includes("protected")) return "protected";
  if (modifiers.includes("public")) return "public";
  return "internal";
}

function accessOf(modifiers: readonly string[], isInterface: boolean): string {
  return accessKind(modifiers, null, isInterface);
}

function metadataInfo(metadata: readonly AST.Metadata[]): TypeMetadata[] {
  return metadata.map((item) => ({
    name: item.name,
    args: item.args.map((arg) => ({ name: arg.name, value: arg.value })),
  }));
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    a.span.file.localeCompare(b.span.file) ||
    a.span.line - b.span.line ||
    a.span.column - b.span.column ||
    a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
}

function fallbackSpan(): Span {
  return { file: "<unknown>", start: 0, end: 0, line: 1, column: 1 };
}

