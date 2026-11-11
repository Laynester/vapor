import type * as AST from "../ast.ts";
import {
  RUNTIME_EXTERNAL_CLASSES,
  RUNTIME_EXTERNAL_INTERFACES,
} from "../../../shared/src/runtime-bindings.ts";
import { diag, type Diagnostic } from "../diagnostics.ts";
import type { MemberInfo, ProjectGraph, TypeInfo } from "../semantic/types.ts";
import type { SourceUnit } from "../semantic/analyzer.ts";
import type {
  IRAccessor,
  IRCase,
  IRCatch,
  IRClass,
  IRExpr,
  IRField,
  IRFunction,
  IRInterface,
  IRMethod,
  IRMetadata,
  IRMetadataValue,
  IRParam,
  IRProgram,
  IRStmt,
  IRStaticValue,
} from "./types.ts";

export interface LowerResult {
  program: IRProgram;
  diagnostics: Diagnostic[];
}

class LowerError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(code: string, message: string, at: AST.Node) {
    super(message);
    this.diagnostic = diag("error", code, message, at.span);
  }
}

interface FnContext {
  info: TypeInfo;
  base: string | null;
  locals: Set<string>;
  static: boolean;
  /** `with` objects in innermost-first order. */
  withObjects?: IRExpr[];
  /** An E4X filter predicate evaluates `this` against the current node. */
  filter?: boolean;
}

const BUILTIN_REFS = new Set([
  "Object",
  "Array",
  "Class",
  "Function",
  "String",
  "Number",
  "Boolean",
  "Error",
  "Math",
  "JSON",
  "XML",
  "XMLList",
  "RegExp",
  "Date",
]);

const GLOBALS = new Set([
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
  "NaN",
  "Infinity",
  "undefined",
]);

function qualifiedName(packageName: string, name: string): string {
  return packageName ? `${packageName}.${name}` : name;
}

/** Constants on AS3 primitive wrapper classes that are not JS globals. */
function primitiveStaticValue(dotted: string): number | undefined {
  switch (dotted) {
    case "int.MAX_VALUE": return 2147483647;
    case "int.MIN_VALUE": return -2147483648;
    case "uint.MAX_VALUE": return 4294967295;
    case "uint.MIN_VALUE": return 0;
    default: return undefined;
  }
}

/** Dotted spelling of an identifier/member chain, or null when it has a computed step. */
function dottedName(node: AST.Expression): string | null {
  if (node.kind === "Identifier") return node.name;
  if (node.kind === "MemberExpression" && !node.computed && typeof node.property === "string") {
    const object = dottedName(node.object);
    return object ? `${object}.${node.property}` : null;
  }
  return null;
}

function staticPropertyName(property: string | AST.Expression): string | null {
  if (typeof property === "string") return property;
  if (property.kind === "Literal" && typeof property.value === "string") return property.value;
  return null;
}

function typeName(node: AST.TypeNode | null): string {
  if (!node) return "*";
  if (node.kind === "WildcardType") return "*";
  if (node.kind === "VectorType") return `Vector.<${typeName(node.element)}>`;
  return node.name;
}

function defaultConst(type: string): string | number | boolean | null {
  if (type === "int" || type === "uint" || type === "Number") return 0;
  if (type === "Boolean") return false;
  return null;
}

function metadataValue(value: AST.MetadataValue): IRMetadataValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value.kind === "IdentifierValue") return value.name;
  return value.values.map(metadataValue);
}

function lowerMetadata(metadata: readonly AST.Metadata[]): IRMetadata[] {
  return metadata.map((item) => ({
    name: item.name,
    args: item.args.map((arg) => ({ name: arg.name ?? "", value: metadataValue(arg.value) })),
  }));
}

function literalValue(expr: AST.Expression | null): IRStaticValue | null {
  if (!expr || expr.kind !== "Literal") return null;
  if (expr.literalKind === "regex" || expr.literalKind === "xml") return null;
  return { type: "*", value: expr.value, readonly: false };
}

/**
 * AS3 hoists local declarations to the enclosing function, so closures may capture
 * variables that are declared later in the body. Collect them before lowering.
 */
function hoistLocals(statement: AST.Statement, into: Set<string>): void {
  switch (statement.kind) {
    case "BlockStatement":
      for (const child of statement.body) hoistLocals(child, into);
      return;
    case "VariableStatement":
      for (const declaration of statement.declarations) into.add(declaration.name);
      return;
    case "IfStatement":
      hoistLocals(statement.consequent, into);
      if (statement.alternate) hoistLocals(statement.alternate, into);
      return;
    case "WhileStatement":
    case "DoWhileStatement":
      hoistLocals(statement.body, into);
      return;
    case "ForStatement":
      if (Array.isArray(statement.init)) {
        for (const declaration of statement.init) into.add(declaration.name);
      }
      hoistLocals(statement.body, into);
      return;
    case "ForInStatement":
      if (statement.declaration) into.add(statement.declaration.name);
      hoistLocals(statement.body, into);
      return;
    case "SwitchStatement":
      for (const item of statement.cases) {
        for (const child of item.statements) hoistLocals(child, into);
      }
      return;
    case "TryStatement":
      hoistLocals(statement.block, into);
      for (const clause of statement.catches) {
        into.add(clause.name);
        hoistLocals(clause.block, into);
      }
      if (statement.finalizer) hoistLocals(statement.finalizer, into);
      return;
    case "LabeledStatement":
      hoistLocals(statement.statement, into);
      return;
    default:
      return;
  }
}

export function lowerProject(units: readonly SourceUnit[], graph: ProjectGraph): LowerResult {
  const types = new Map(
    graph.types.filter((type) => type.origin === "source").map((type) => [type.fqcn, type]),
  );
  const simpleTypes = new Map<string, string[]>();
  for (const type of types.values()) {
    const list = simpleTypes.get(type.name) ?? [];
    list.push(type.fqcn);
    simpleTypes.set(type.name, list);
  }
  // The semantic graph knows every external signature. References to any of them can be
  // lowered to `$runtimeClass`; the runtime reports a concrete binding error if the API is
  // not implemented. Bindable bases/interfaces are still limited by the runtime manifest.
  const runtimeTypes = new Set([
    ...graph.runtime.types,
    ...Object.keys(RUNTIME_EXTERNAL_CLASSES),
    ...Object.keys(RUNTIME_EXTERNAL_INTERFACES),
  ]);
  const simpleRuntimeTypes = new Map<string, string[]>();
  for (const fqcn of runtimeTypes) {
    const simple = fqcn.slice(fqcn.lastIndexOf(".") + 1);
    const list = simpleRuntimeTypes.get(simple) ?? [];
    list.push(fqcn);
    simpleRuntimeTypes.set(simple, list);
  }
  const runtimeValues = new Set(graph.runtime.values);
  const simpleRuntimeValues = new Map<string, string[]>();
  for (const fqcn of runtimeValues) {
    const simple = fqcn.slice(fqcn.lastIndexOf(".") + 1);
    const list = simpleRuntimeValues.get(simple) ?? [];
    list.push(fqcn);
    simpleRuntimeValues.set(simple, list);
  }

  const classes: IRClass[] = [];
  const interfaces: IRInterface[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const unit of units) {
    for (const declaration of unit.program.declarations) {
      if (declaration.kind === "InterfaceDeclaration") {
        const fqcn = qualifiedName(unit.program.packageName ?? "", declaration.name);
        const info = types.get(fqcn);
        if (info) {
          const externalParent = info.interfaces.find(
            (parent) => !types.has(parent) && !runtimeTypes.has(parent),
          );
          if (externalParent) {
            diagnostics.push(diag(
              "error",
              "IR006",
              `External interface ${externalParent} is not supported by this backend slice`,
              declaration.span,
            ));
            continue;
          }
          interfaces.push({
            fqcn,
            name: info.name,
            extends: [...info.interfaces],
            span: declaration.span,
          });
        }
        continue;
      }
      if (declaration.kind !== "ClassDeclaration") continue;
      const fqcn = qualifiedName(unit.program.packageName ?? "", declaration.name);
      const info = types.get(fqcn);
      if (!info) continue;
      const externalInterface = info.interfaces.find(
        (implemented) => !types.has(implemented) && !runtimeTypes.has(implemented),
      );
      if (externalInterface) {
        diagnostics.push(diag(
          "error",
          "IR006",
          `External interface ${externalInterface} is not supported by this backend slice`,
          declaration.span,
        ));
        continue;
      }
      try {
        classes.push(
          new ClassLowerer(
            unit, declaration, info, types, simpleTypes, runtimeTypes, simpleRuntimeTypes,
            runtimeValues, simpleRuntimeValues,
          ).lower(),
        );
      } catch (error) {
        if (error instanceof LowerError) {
          diagnostics.push(error.diagnostic);
        } else {
          throw error;
        }
      }
    }
  }

  classes.sort((a, b) => a.fqcn.localeCompare(b.fqcn));
  interfaces.sort((a, b) => a.fqcn.localeCompare(b.fqcn));
  return {
    program: { version: 1, classes, interfaces, runtimeTypes: [...runtimeTypes].sort() },
    diagnostics,
  };
}

class ClassLowerer {
  private readonly unit: SourceUnit;
  private readonly declaration: AST.ClassDeclaration;
  private readonly info: TypeInfo;
  private readonly types: Map<string, TypeInfo>;
  private readonly simpleTypes: Map<string, string[]>;
  private readonly runtimeTypes: Set<string>;
  private readonly simpleRuntimeTypes: Map<string, string[]>;
  private readonly runtimeValues: Set<string>;
  private readonly simpleRuntimeValues: Map<string, string[]>;
  private readonly importedTypes = new Map<string, string>();
  private readonly wildcardImports: string[] = [];
  private readonly fields: IRField[] = [];
  private readonly statics: IRField[] = [];
  private readonly accessors = new Map<string, IRAccessor>();
  private readonly methods: IRMethod[] = [];
  private readonly staticMethods: IRMethod[] = [];
  private readonly staticAccessors = new Map<string, IRAccessor>();
  private readonly staticValues: Record<string, IRStaticValue> = {};
  private readonly staticStatements: IRStmt[] = [];
  private ctor: IRFunction = { params: [], body: [] };

  constructor(
    unit: SourceUnit,
    declaration: AST.ClassDeclaration,
    info: TypeInfo,
    types: Map<string, TypeInfo>,
    simpleTypes: Map<string, string[]>,
    runtimeTypes: Set<string>,
    simpleRuntimeTypes: Map<string, string[]>,
    runtimeValues: Set<string>,
    simpleRuntimeValues: Map<string, string[]>,
  ) {
    this.unit = unit;
    this.declaration = declaration;
    this.info = info;
    this.types = types;
    this.simpleTypes = simpleTypes;
    this.runtimeTypes = runtimeTypes;
    this.simpleRuntimeTypes = simpleRuntimeTypes;
    this.runtimeValues = runtimeValues;
    this.simpleRuntimeValues = simpleRuntimeValues;
    for (const declaration of unit.program.imports) {
      if (declaration.wildcard) {
        this.wildcardImports.push(declaration.name);
        continue;
      }
      const simple = declaration.name.slice(declaration.name.lastIndexOf(".") + 1);
      if (simple) this.importedTypes.set(simple, declaration.name);
    }
  }

  lower(): IRClass {
    const base = this.info.base === "Object" ? null : this.info.base;
    if (base && !this.types.has(base) && !this.runtimeTypes.has(base)) {
      this.fail("IR005", `Backend does not yet support external base class '${base}'`, this.declaration);
    }
    this.collectMembers();
    return {
      fqcn: this.info.fqcn,
      name: this.info.name,
      packageName: this.info.packageName,
      base,
      interfaces: [...this.info.interfaces],
      metadata: lowerMetadata(this.declaration.metadata),
      final: this.info.flags.final,
      dynamic: this.info.flags.dynamic,
      fields: this.fields,
      accessors: [...this.accessors.values()],
      methods: this.methods,
      ctor: this.ctor,
      staticFields: this.statics,
      staticMethods: this.staticMethods,
      staticAccessors: [...this.staticAccessors.values()],
      staticValues: this.staticValues,
      staticInit: this.staticStatements.length > 0
        ? { params: [], body: [{ k: "block", body: this.staticStatements }], span: this.declaration.span }
        : null,
      span: this.declaration.span,
    };
  }

  private collectMembers(): void {
    const base = this.info.base === "Object" ? null : this.info.base;
    let constructor: AST.MethodDeclaration | null = null;

    for (const member of this.declaration.members) {
      if (member.kind === "FieldDeclaration") {
        const field: IRField = {
          name: member.name,
          type: typeName(member.type),
          readonly: member.isConst,
          static: member.modifiers.includes("static"),
        };
        if (field.static) {
          this.statics.push(field);
          const value = literalValue(member.initializer);
          if (value) {
            this.staticValues[field.name] = {
              ...value,
              type: field.type,
              readonly: field.readonly,
            };
          } else if (member.initializer) {
            const ctx: FnContext = {
              info: this.info,
              base,
              locals: new Set(),
              static: true,
            };
            this.staticStatements.push({
              k: "expr",
              expr: {
                k: "assign",
                target: { k: "member", object: { k: "this" }, property: field.name },
                op: "=",
                value: this.lowerExpr(member.initializer, ctx),
              },
            });
          } else {
            this.staticValues[field.name] = {
              type: field.type,
              value: defaultConst(field.type),
              readonly: field.readonly,
            };
          }
        } else {
          this.fields.push(field);
        }
        continue;
      }

      if (member.kind === "ClassInitializer") {
        // The decompiled corpus emits class initializer blocks without an explicit
        // `static` modifier. They run in the static initialization phase, after static
        // field initializers, so lower them there rather than inventing an instance phase.
        const ctx: FnContext = {
          info: this.info,
          base,
          locals: new Set(),
          static: true,
        };
        hoistLocals(member.body, ctx.locals);
        for (const statement of member.body.body) {
          this.staticStatements.push(this.lowerStmt(statement, ctx));
        }
        continue;
      }

      if (member.kind === "MethodDeclaration") {
        if (member.isConstructor) {
          constructor = member;
          continue;
        }
        const method = this.lowerMethod(member, base);
        if (member.accessor) {
          // Static accessors live on the class object, not on the instance prototype.
          const accessors = method.static ? this.staticAccessors : this.accessors;
          const existing = accessors.get(member.name) ?? {
            name: member.name,
            type: method.type,
            get: null,
            set: null,
            span: member.span,
          };
          if (member.accessor === "get") existing.get = { params: method.params, body: method.body, span: member.span };
          else existing.set = { params: method.params, body: method.body, span: member.span };
          accessors.set(member.name, existing);
        } else if (method.static) {
          this.staticMethods.push(method);
        } else {
          this.methods.push(method);
        }
      }
    }

    this.ctor = this.lowerConstructor(constructor, base);
  }

  /** True when a statement contains a `super(...)` call at any depth (e.g. inside `try`). */
  private containsSuperConstructorCall(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => this.containsSuperConstructorCall(item));
    const node = value as Record<string, unknown>;
    // Statements are lowered before this check, so look for the IR node too.
    if (node.k === "superCall" && node.name === null) return true;
    if (node.kind === "CallExpression" && (node.callee as any)?.kind === "SuperExpression") {
      return true;
    }
    return Object.entries(node).some(
      ([key, child]) => key !== "span" && key !== "kind" && this.containsSuperConstructorCall(child),
    );
  }

  private lowerConstructor(declaration: AST.MethodDeclaration | null, base: string | null): IRFunction {
    const locals = new Set(declaration?.params.map((param) => param.name) ?? []);
    const ctx: FnContext = { info: this.info, base, locals, static: false };
    const params = declaration ? this.lowerParams(declaration.params, ctx) : [];
    let statements: IRStmt[] = [];
    if (declaration?.body) {
      hoistLocals(declaration.body, locals);
      statements = declaration.body.body.map((statement) => this.lowerStmt(statement, ctx));
    }

    // Decompiled constructors may run statements (message tables, timers, port lists)
    // before `super(...)`; the bytecode executes them in that order. Hoisting the super
    // call to the top of the generated constructor would hide that state from base
    // constructors that invoke overridden methods (for example dependency injection
    // calling `initComponent` while the subclass constructor is still running).
    const superIndex = statements.findIndex(
      (statement) => statement.k === "expr" && statement.expr.k === "superCall" && statement.expr.name === null,
    );
    // A super call nested in `try` (or any expression) is still the constructor's
    // super call; injecting an implicit empty one would construct the base twice.
    const nestedSuper = statements.some(
      (statement, index) => index !== superIndex && this.containsSuperConstructorCall(statement),
    );

    const body: IRStmt[] = [];
    if (base && superIndex < 0 && !nestedSuper) {
      body.push({ k: "expr", expr: { k: "superCall", base, name: null, args: [] } });
    }
    for (const field of this.fields) {
      const declarationMember = this.declaration.members.find(
        (member): member is AST.FieldDeclaration =>
          member.kind === "FieldDeclaration" && member.name === field.name && !member.modifiers.includes("static"),
      );
      const value = declarationMember?.initializer
        ? this.lowerExpr(declarationMember.initializer, ctx)
        : { k: "const" as const, value: defaultConst(field.type) };
      body.push({
        k: "expr",
        expr: {
          k: "assign",
          target: { k: "member", object: { k: "this" }, property: field.name },
          op: "=",
          value,
        },
      });
    }
    body.push(...statements);
    return { params, body, span: declaration?.span };
  }

  private lowerMethod(member: AST.MethodDeclaration, base: string | null): IRMethod {
    const locals = new Set(member.params.map((param) => param.name));
    const ctx: FnContext = {
      info: this.info,
      base,
      locals,
      static: member.modifiers.includes("static"),
    };
    const params = this.lowerParams(member.params, ctx);
    if (member.body) hoistLocals(member.body, locals);
    const body = member.body
      ? member.body.body.map((statement) => this.lowerStmt(statement, ctx))
      : [];
    return {
      name: member.name,
      type: member.accessor === "set"
        ? typeName(member.params[0]?.type ?? null)
        : typeName(member.returnType),
      params,
      body,
      static: member.modifiers.includes("static"),
      span: member.span,
    };
  }

  private lowerLocalInitializer(declaration: AST.VariableDeclaration, ctx: FnContext): IRExpr | null {
    if (declaration.initializer) return this.lowerExpr(declaration.initializer, ctx);
    const type = typeName(declaration.type);
    return type === "*" ? null : { k: "const", value: defaultConst(type) };
  }

  private lowerParams(params: readonly AST.Parameter[], ctx: FnContext): IRParam[] {
    return params.map((param) => ({
      name: param.name,
      type: typeName(param.type),
      optional: param.defaultValue !== null,
      rest: param.rest,
      defaultValue: param.defaultValue ? this.lowerExpr(param.defaultValue, ctx) : null,
    }));
  }

  private lowerStmt(statement: AST.Statement, ctx: FnContext): IRStmt {
    const lowered = this.lowerStmtInner(statement, ctx);
    lowered.span = statement.span;
    return lowered;
  }

  private lowerStmtInner(statement: AST.Statement, ctx: FnContext): IRStmt {
    switch (statement.kind) {
      case "BlockStatement":
        return { k: "block", body: statement.body.map((child) => this.lowerStmt(child, ctx)) };
      case "VariableStatement": {
        const declarations = statement.declarations;
        const lowered = declarations.map((declaration) => {
          ctx.locals.add(declaration.name);
          return {
            k: "var" as const,
            name: declaration.name,
            type: typeName(declaration.type),
            init: this.lowerLocalInitializer(declaration, ctx),
            const: statement.isConst,
          };
        });
        if (lowered.length === 1) return lowered[0]!;
        return { k: "block", body: lowered };
      }
      case "ExpressionStatement":
        return { k: "expr", expr: this.lowerExpr(statement.expression, ctx) };
      case "IfStatement":
        return {
          k: "if",
          test: this.lowerExpr(statement.test, ctx),
          then: this.lowerStmt(statement.consequent, ctx),
          else: statement.alternate ? this.lowerStmt(statement.alternate, ctx) : null,
        };
      case "WhileStatement":
        return {
          k: "while",
          test: this.lowerExpr(statement.test, ctx),
          body: this.lowerStmt(statement.body, ctx),
        };
      case "DoWhileStatement":
        return {
          k: "do",
          body: this.lowerStmt(statement.body, ctx),
          test: this.lowerExpr(statement.test, ctx),
        };
      case "ForStatement": {
        const init: IRStmt[] = [];
        if (Array.isArray(statement.init)) {
          for (const declaration of statement.init) {
            ctx.locals.add(declaration.name);
            init.push({
              k: "var",
              name: declaration.name,
              type: typeName(declaration.type),
              init: this.lowerLocalInitializer(declaration, ctx),
              const: false,
            });
          }
        } else if (statement.init) {
          init.push({ k: "expr", expr: this.lowerExpr(statement.init, ctx) });
        }
        return {
          k: "for",
          init,
          test: statement.test ? this.lowerExpr(statement.test, ctx) : null,
          update: statement.update ? this.lowerExpr(statement.update, ctx) : null,
          body: this.lowerStmt(statement.body, ctx),
        };
      }
      case "ReturnStatement":
        return {
          k: "return",
          value: statement.expression ? this.lowerExpr(statement.expression, ctx) : null,
        };
      case "BreakStatement":
        return { k: "break", label: statement.label };
      case "ContinueStatement":
        return { k: "continue", label: statement.label };
      case "LabeledStatement":
        return {
          k: "label",
          label: statement.label,
          body: this.lowerStmt(statement.statement, ctx),
        };
      case "ForInStatement": {
        if (statement.declaration) ctx.locals.add(statement.declaration.name);
        return {
          k: "forIn",
          each: statement.each,
          declaration: statement.declaration
            ? { name: statement.declaration.name, type: typeName(statement.declaration.type) }
            : null,
          target: statement.declaration ? null : this.lowerExpr(statement.target, ctx),
          iterable: this.lowerExpr(statement.iterable, ctx),
          body: this.lowerStmt(statement.body, ctx),
        };
      }
      case "ThrowStatement":
        return { k: "throw", value: this.lowerExpr(statement.expression, ctx) };
      case "SwitchStatement":
        return {
          k: "switch",
          discriminant: this.lowerExpr(statement.discriminant, ctx),
          cases: statement.cases.map((item): IRCase => ({
            test: item.test ? this.lowerExpr(item.test, ctx) : null,
            body: item.statements.map((child) => this.lowerStmt(child, ctx)),
          })),
        };
      case "TryStatement":
        return {
          k: "try",
          body: statement.block.body.map((child) => this.lowerStmt(child, ctx)),
          catches: statement.catches.map((clause): IRCatch => ({
            name: clause.name,
            type: clause.type ? this.testType(clause.type, ctx) : null,
            body: clause.block.body.map((child) => this.lowerStmt(child, ctx)),
          })),
          finalizer: statement.finalizer
            ? statement.finalizer.body.map((child) => this.lowerStmt(child, ctx))
            : null,
        };
      case "WithStatement": {
        const object = this.lowerExpr(statement.object, ctx);
        return this.lowerStmt(statement.body, {
          ...ctx,
          withObjects: [...(ctx.withObjects ?? []), object],
        });
      }
      case "EmptyStatement":
        return { k: "empty" };
      default:
        this.fail("IR007", `Statement '${statement.kind}' is not lowered by this backend slice`, statement);
    }
  }

  private lowerExpr(expression: AST.Expression, ctx: FnContext): IRExpr {
    switch (expression.kind) {
      case "ThisExpression":
        return { k: "this" };
      case "SuperExpression":
        this.fail("IR008", "`super` is only supported as a constructor call or member base", expression);
      case "Identifier":
        return this.lowerIdentifier(expression, ctx);
      case "Literal":
        if (expression.literalKind === "xml") {
          return { k: "xmlLiteral", value: String(expression.value ?? "") };
        }
        if (expression.literalKind === "regex") {
          return { k: "regex", raw: String(expression.raw) };
        }
        return { k: "const", value: expression.value };
      case "ArrayLiteral":
        return {
          k: "array",
          values: expression.elements.map((element) =>
            element ? this.lowerExpr(element, ctx) : { k: "const", value: undefined },
          ),
        };
      case "TypedArrayExpression":
        return {
          k: "vector",
          element: typeName(expression.elementType),
          values: expression.elements.map((element) =>
            element ? this.lowerExpr(element, ctx) : { k: "const", value: undefined },
          ),
          length: null,
        };
      case "ObjectLiteral":
        return {
          k: "object",
          entries: expression.properties.map((property) => [
            property.key,
            this.lowerExpr(property.value, ctx),
          ]),
        };
      case "FunctionExpression": {
        const locals = new Set(ctx.locals);
        for (const param of expression.params) locals.add(param.name);
        hoistLocals(expression.body, locals);
        const fnCtx: FnContext = {
          info: ctx.info,
          base: ctx.base,
          locals,
          static: ctx.static,
          ...(ctx.withObjects ? { withObjects: ctx.withObjects } : {}),
          ...(ctx.filter ? { filter: ctx.filter } : {}),
        };
        const params = this.lowerParams(expression.params, fnCtx);
        return {
          k: "function",
          name: expression.name,
          params,
          body: expression.body.body.map((child) => this.lowerStmt(child, fnCtx)),
        };
      }
      case "NewExpression": {
        if (expression.target.kind === "VectorTypeExpression") {
          const element = typeName(expression.target.element);
          return {
            k: "vector",
            element,
            values: [],
            length: expression.args[0] ? this.lowerExpr(expression.args[0], ctx) : null,
          };
        }
        const target = this.lowerExpr(expression.target, ctx);
        return {
          k: "construct",
          classRef: target,
          args: expression.args.map((argument) => this.lowerExpr(argument, ctx)),
        };
      }
      case "CallExpression": {
        if (expression.callee.kind === "SuperExpression") {
          // Every AS3 class implicitly extends Object. Object's constructor is a no-op;
          // an explicit `super()` in a class without a declared base is therefore valid.
          if (!ctx.base) return { k: "const", value: undefined };
          return {
            k: "superCall",
            base: ctx.base,
            name: null,
            args: expression.args.map((argument) => this.lowerExpr(argument, ctx)),
          };
        }
        if (
          expression.callee.kind === "Identifier" &&
          ["int", "uint", "Number", "String", "Boolean"].includes(expression.callee.name) &&
          expression.args.length === 1
        ) {
          return {
            k: "coerce",
            value: this.lowerExpr(expression.args[0]!, ctx),
            type: expression.callee.name,
          };
        }
        if (expression.callee.kind === "VectorTypeExpression" && expression.args.length === 1) {
          // `Vector.<T>(value)` converts an Array or Vector into a new vector of T; it is
          // not a cast of the value to T.
          return {
            k: "vectorCast",
            value: this.lowerExpr(expression.args[0]!, ctx),
            element: typeName(expression.callee.element),
          };
        }
        if (
          expression.callee.kind === "MemberExpression" &&
          expression.callee.object.kind === "SuperExpression" &&
          typeof expression.callee.property === "string"
        ) {
          if (!ctx.base) {
            return {
              k: "call",
              callee: { k: "member", object: { k: "this" }, property: expression.callee.property },
              args: expression.args.map((argument) => this.lowerExpr(argument, ctx)),
            };
          }
          return {
            k: "superCall",
            base: ctx.base,
            name: expression.callee.property,
            args: expression.args.map((argument) => this.lowerExpr(argument, ctx)),
          };
        }
        const callee = this.lowerCallee(expression.callee, ctx);
        if (callee.k === "classRef" && expression.args.length === 1) {
          return {
            k: "cast",
            value: this.lowerExpr(expression.args[0]!, ctx),
            type: callee.fqcn,
          };
        }
        return {
          k: "call",
          callee,
          args: expression.args.map((argument) => this.lowerExpr(argument, ctx)),
        };
      }
      case "XmlFilterExpression": {
        const predicate = this.lowerExpr(expression.predicate, {
          ...ctx,
          filter: true,
          withObjects: [],
        });
        return {
          k: "xmlFilter",
          object: this.lowerExpr(expression.object, ctx),
          predicate: {
            params: [],
            body: [{ k: "return", value: predicate, span: expression.predicate.span }],
            span: expression.predicate.span,
          },
        };
      }
      case "AttributeSelectorExpression":
        return { k: "xmlAttribute", object: { k: "this" }, property: expression.name };
      case "MemberExpression": {
        const dotted = dottedName(expression);
        if (dotted) {
          const primitive = primitiveStaticValue(dotted);
          if (primitive !== undefined) return { k: "const", value: primitive };
          const fqcn = this.lookupClass(dotted, ctx);
          if (fqcn) return { k: "classRef", fqcn };
        }
        if (expression.access === "attribute") {
          const property = staticPropertyName(expression.property);
          if (property === null) {
            this.fail("IR010", "Dynamic XML attribute access is not lowered yet", expression);
          }
          return { k: "xmlAttribute", object: this.lowerExpr(expression.object, ctx), property };
        }
        if (expression.access === "descendant" && typeof expression.property === "string") {
          return { k: "xmlDescendants", object: this.lowerExpr(expression.object, ctx), property: expression.property };
        }
        if (!expression.computed) {
          const dotted = dottedName(expression);
          if (dotted && this.runtimeValues.has(dotted)) return { k: "runtimeValue", name: dotted };
        }
        if (expression.object.kind === "SuperExpression") {
          if (!ctx.base) {
            if (typeof expression.property !== "string") {
              this.fail("IR010", "Computed `super` access is not lowered yet", expression);
            }
            return { k: "member", object: { k: "this" }, property: expression.property };
          }
          if (typeof expression.property !== "string") {
            this.fail("IR010", "Computed `super` access is not lowered yet", expression);
          }
          return { k: "superGet", base: ctx.base, property: expression.property };
        }
        const object = this.lowerExpr(expression.object, ctx);
        if (expression.computed) {
          return {
            k: "index",
            object,
            index: typeof expression.property === "string"
              ? { k: "const", value: expression.property }
              : this.lowerExpr(expression.property, ctx),
          };
        }
        if (typeof expression.property !== "string") {
          this.fail("IR010", "Dynamic property access is not lowered yet", expression);
        }
        let resolved: MemberInfo | undefined;
        if (!ctx.filter && expression.object.kind === "ThisExpression") {
          resolved = this.findInheritedMemberInfo(ctx.info, expression.property, ctx.static);
        } else if (!ctx.filter) {
          const owner = dottedName(expression.object);
          const ownerFqcn = owner ? this.lookupClass(owner, ctx) : null;
          const ownerInfo = ownerFqcn ? this.types.get(ownerFqcn) : undefined;
          resolved = ownerInfo?.statics.find((member) => member.name === expression.property);
        }
        const isMethod = resolved?.kind === "method";
        return {
          k: "member",
          object,
          property: expression.property,
          ...(isMethod ? { bound: true } : {}),
          ...this.privateBinding(resolved),
        };
      }
      case "UnaryExpression":
        if (expression.operator === "delete" && expression.operand.kind === "Identifier") {
          // AS3 only allows delete on properties; emitting JS `delete local` is a syntax error.
          this.fail("IR010", "The operand of delete must be a property, not a local variable", expression);
        }
        if (expression.operator === "++" || expression.operator === "--") {
          if (
            ctx.base &&
            expression.operand.kind === "MemberExpression" &&
            expression.operand.object.kind === "SuperExpression"
          ) {
            if (typeof expression.operand.property !== "string") {
              this.fail("IR010", "Computed `super` access is not lowered yet", expression);
            }
            return {
              k: "superUpdate",
              base: ctx.base,
              property: expression.operand.property,
              op: expression.operator,
              prefix: expression.prefix,
            };
          }
          return {
            k: "update",
            op: expression.operator,
            operand: this.lowerExpr(expression.operand, ctx),
            prefix: expression.prefix,
          };
        }
        return {
          k: "unary",
          op: expression.operator,
          operand: this.lowerExpr(expression.operand, ctx),
          prefix: expression.prefix,
        };
      case "BinaryExpression":
        return {
          k: "binary",
          op: expression.operator,
          left: this.lowerExpr(expression.left, ctx),
          right: this.lowerExpr(expression.right, ctx),
        };
      case "ConditionalExpression":
        return {
          k: "conditional",
          test: this.lowerExpr(expression.test, ctx),
          then: this.lowerExpr(expression.consequent, ctx),
          else: this.lowerExpr(expression.alternate, ctx),
        };
      case "AssignmentExpression": {
        if (expression.left.kind === "MemberExpression" && expression.left.access === "attribute") {
          const property = staticPropertyName(expression.left.property);
          if (property === null) {
            this.fail("IR010", "Dynamic XML attribute writes are not lowered yet", expression);
          }
          if (expression.operator !== "=") {
            this.fail("IR010", `Compound assignment to XML attribute '${property}' is not lowered yet`, expression);
          }
          return {
            k: "xmlSetAttribute",
            object: this.lowerExpr(expression.left.object, ctx),
            property,
            value: this.lowerExpr(expression.right, ctx),
          };
        }
        if (
          ctx.base &&
          expression.left.kind === "MemberExpression" &&
          expression.left.object.kind === "SuperExpression"
        ) {
          if (typeof expression.left.property !== "string") {
            this.fail("IR010", "Computed `super` access is not lowered yet", expression);
          }
          if (expression.operator === "||=" || expression.operator === "&&=") {
            this.fail("IR010", `Logical assignment to 'super.${expression.left.property}' is not lowered yet`, expression);
          }
          const value = this.lowerExpr(expression.right, ctx);
          return {
            k: "superSet",
            base: ctx.base,
            property: expression.left.property,
            value: expression.operator === "="
              ? value
              : {
                k: "binary",
                op: expression.operator.slice(0, -1),
                left: { k: "superGet", base: ctx.base, property: expression.left.property },
                right: value,
              },
          };
        }
        return {
          k: "assign",
          target: this.lowerExpr(expression.left, ctx),
          op: expression.operator,
          value: this.lowerExpr(expression.right, ctx),
        };
      }
      case "TypeTestExpression":
        return {
          k: expression.operator === "is" ? "is" : "cast",
          value: this.lowerExpr(expression.expression, ctx),
          type: this.testType(expression.type, ctx),
        };
      case "SequenceExpression":
        return {
          k: "sequence",
          expressions: expression.expressions.map((child) => this.lowerExpr(child, ctx)),
        };
      case "ParenthesizedExpression":
        return this.lowerExpr(expression.expression, ctx);
      default:
        this.fail("IR011", `Expression '${expression.kind}' is not lowered by this backend slice`, expression);
    }
  }

  /** Resolves a type used in `is`, `as` and catch clauses to a runtime value. */
  private testType(type: AST.TypeNode, ctx: FnContext): string {
    if (type.kind === "NamedType") return this.lookupClass(type.name, ctx) ?? type.name;
    return typeName(type);
  }

  private lowerIdentifier(expression: AST.Identifier, ctx: FnContext): IRExpr {
    const name = expression.name;
    if (ctx.locals.has(name)) return { k: "local", name };

    const staticMember = ctx.info.statics.find((member) => member.name === name);
    if (staticMember) {
      return {
        k: "member",
        object: { k: "classRef", fqcn: ctx.info.fqcn },
        property: name,
        ...(staticMember.kind === "method" ? { bound: true } : {}),
      };
    }
    const field = ctx.info.members.find((member) => member.name === name && member.kind === "field");
    if (field) return { k: "member", object: { k: "this" }, property: name };

    // Unqualified static members are visible from instance methods as well as static
    // methods. Instance members remain visible only from instance methods.
    const inherited = this.findInheritedMemberInfo(ctx.info, name, ctx.static) ??
      (!ctx.static ? this.findInheritedMemberInfo(ctx.info, name, true) : undefined);
    if (inherited) {
      return {
        k: "member",
        object: inherited.static
          ? { k: "classRef", fqcn: inherited.declaredIn }
          : { k: "this" },
        property: name,
        ...(inherited.kind === "method" ? { bound: true } : {}),
        ...this.privateBinding(inherited),
      };
    }

    if (name === ctx.info.name) return { k: "classRef", fqcn: ctx.info.fqcn };
    const classFqcn = this.lookupClass(name, ctx);
    if (classFqcn) {
      if (classFqcn === "XML" || classFqcn === "XMLList") return { k: "runtimeClass", fqcn: classFqcn };
      return { k: "classRef", fqcn: classFqcn };
    }
    const runtimeValue = this.lookupRuntimeValue(name, ctx);
    if (runtimeValue) return { k: "runtimeValue", name: runtimeValue };
    if (GLOBALS.has(name)) return { k: "global", name };

    // A runtime base may expose members the semantic manifest does not describe. The
    // semantic analyzer already treats those as dynamic; lower the same way instead of
    // failing an otherwise valid inherited call.
    // E4X filter predicates expose the current node's methods and attributes through
    // `this`; ordinary class members are not resolved from inside the predicate first.
    if (ctx.filter) return { k: "member", object: { k: "this" }, property: name };

    // `with` is dynamically scoped. Resolve names that are not locals/class members
    // against the innermost with object; this is the same fallback AS3 uses here.
    if (ctx.withObjects && ctx.withObjects.length > 0) {
      return { k: "member", object: ctx.withObjects[ctx.withObjects.length - 1]!, property: name };
    }

    // A runtime base may expose members the semantic manifest does not describe. The
    // semantic analyzer already treats those as dynamic; lower the same way instead of
    // failing an otherwise valid inherited call.
    if (this.hasRuntimeAncestor(ctx.info)) {
      return { k: "member", object: { k: "this" }, property: name };
    }

    this.fail("IR012", `Cannot lower identifier '${name}'`, expression);
  }

  /**
   * AS3 private members are not virtual: a subclass may declare its own method with the same
   * name, and the base class's reference must still reach the base implementation. Record the
   * declaring class so the backend can emit a statically bound method reference.
   */
  private privateBinding(member: MemberInfo | undefined): { bindTo?: string } {
    if (!member || member.kind !== "method") return {};
    if (member.access !== "private") return {};
    return { bindTo: member.declaredIn };
  }

  private findInheritedMemberInfo(info: TypeInfo, name: string, isStatic: boolean): MemberInfo | undefined {
    let current: TypeInfo | undefined = info;
    const seen = new Set<string>();
    while (current && !seen.has(current.fqcn)) {
      seen.add(current.fqcn);
      const found = (isStatic ? current.statics : current.members).find((member) => member.name === name);
      if (found) return found;
      current = current.base ? this.types.get(current.base) : undefined;
    }
    return undefined;
  }

  /** Calls must use the raw member; references are lowered as bound method closures. */
  private lowerCallee(expression: AST.Expression, ctx: FnContext): IRExpr {
    if (expression.kind === "ParenthesizedExpression") return this.lowerCallee(expression.expression, ctx);
    const callee = this.lowerExpr(expression, ctx);
    if (callee.k === "member" && callee.bound) return { ...callee, bound: false };
    return callee;
  }

  private hasRuntimeAncestor(info: TypeInfo): boolean {
    let current: TypeInfo | undefined = info;
    const seen = new Set<string>();
    while (current && !seen.has(current.fqcn)) {
      seen.add(current.fqcn);
      if (current.base && this.runtimeTypes.has(current.base)) return true;
      current = current.base ? this.types.get(current.base) : undefined;
    }
    return false;
  }

  private lookupRuntimeValue(name: string, ctx: FnContext): string | null {
    if (this.runtimeValues.has(name)) return name;
    if (name.includes(".")) return null;
    const local = qualifiedName(ctx.info.packageName, name);
    if (this.runtimeValues.has(local)) return local;
    const candidates = this.simpleRuntimeValues.get(name) ?? [];
    return candidates.length === 1 ? candidates[0]! : null;
  }

  private lookupClass(name: string, ctx: FnContext): string | null {
    if (BUILTIN_REFS.has(name)) return name;
    const imported = this.importedTypes.get(name);
    if (imported && (this.types.has(imported) || this.runtimeTypes.has(imported))) return imported;
    if (this.types.has(name)) return name;
    if (this.runtimeTypes.has(name)) return name;
    if (!name.includes(".")) {
      const local = qualifiedName(ctx.info.packageName, name);
      if (this.types.has(local)) return local;
      if (this.runtimeTypes.has(local)) return local;
      for (const packageName of this.wildcardImports) {
        const candidate = `${packageName}.${name}`;
        if (this.types.has(candidate)) return candidate;
        if (this.runtimeTypes.has(candidate)) return candidate;
      }
      const candidates = this.simpleTypes.get(name) ?? [];
      if (candidates.length === 1) return candidates[0]!;
      const runtimeCandidates = this.simpleRuntimeTypes.get(name) ?? [];
      if (runtimeCandidates.length === 1) return runtimeCandidates[0]!;
    }
    return null;
  }

  private fail(code: string, message: string, node: AST.Node): never {
    throw new LowerError(code, message, node);
  }
}