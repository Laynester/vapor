import type {
  IRClass,
  IRExpr,
  IRFunction,
  IRInterface,
  IRMethod,
  IRProgram,
  IRStmt,
} from "../ir/types.ts";
import { createSourceMap, spanMapping, type SourceMapping } from "./sourcemap.ts";

export interface EmitOptions {
  /** Runtime module specifier used by generated ES modules. */
  runtimeSpecifier?: string;
  /** Emit source maps and sourceMappingURL comments (default true). */
  sourceMaps?: boolean;
  /** Original source text keyed by span.file, embedded as sourcesContent. */
  sources?: ReadonlyMap<string, string>;
}

export interface EmitResult {
  files: Map<string, string>;
  maps: Map<string, string>;
  mappings: Map<string, SourceMapping[]>;
}

const HELPERS = [
  "$class",
  "$interface",
  "$super",
  "$superCall",
  "$superGet",
  "$superSet",
  "$superUpdate",
  "$int",
  "$uint",
  "$number",
  "$string",
  "$boolean",
  "$typeof",
  "$coerce",
  "$cast",
  "$bindMethod",
  "$is",
  "$vector",
  "$vectorCast",
  "$ensureInit",
  "$getClass",
  "$runtimeClass",
  "$runtimeValue",
  "$xmlAttribute",
  "$xmlSetAttribute",
  "$xmlDescendants",
  "$xmlFilter",
  "$xmlLiteral",
  "$forIn",
  "$forEach",
  "$index",
  "$indexSet",
  "$indexDelete",
  "$indexUpdate",
  "$in",
  "$deleteMember",
];

/** Parameter types AS3 coerces on entry (class-typed parameters are not coerced). */
const COERCIBLE_PARAM_TYPES = new Set(["int", "uint", "Number", "String", "Boolean"]);

const BUILTIN_TYPES = new Set([
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

function fileName(fqcn: string): string {
  return `${fqcn.replaceAll(".", "_")}.mjs`;
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function constText(value: string | number | boolean | null | undefined): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

class Emitter {
  private tempIndex = 0;
  private readonly program: IRProgram;
  private readonly runtimeSpecifier: string;
  private readonly sourceMaps: boolean;
  private readonly sources: ReadonlyMap<string, string>;
  private readonly classNames = new Map<string, string>();
  private readonly interfaceNames = new Map<string, string>();
  private readonly externalNames = new Map<string, string>();
  private readonly classByFqcn = new Map<string, IRClass>();
  private readonly interfaceByFqcn = new Map<string, IRInterface>();

  constructor(program: IRProgram, options: EmitOptions) {
    this.program = program;
    this.runtimeSpecifier = options.runtimeSpecifier ?? "@as3js/runtime";
    this.sourceMaps = options.sourceMaps !== false;
    this.sources = options.sources ?? new Map();
    const used = new Set<string>();
    for (const irClass of program.classes) {
      this.classByFqcn.set(irClass.fqcn, irClass);
    }
    for (const irInterface of program.interfaces) {
      this.interfaceByFqcn.set(irInterface.fqcn, irInterface);
    }
    for (const irClass of [...program.classes].sort((a, b) => a.fqcn.localeCompare(b.fqcn))) {
      let name = irClass.name;
      let suffix = 2;
      while (used.has(name)) name = `${irClass.name}_${suffix++}`;
      used.add(name);
      this.classNames.set(irClass.fqcn, name);
    }
    for (const irInterface of [...program.interfaces].sort((a, b) => a.fqcn.localeCompare(b.fqcn))) {
      let name = irInterface.name;
      let suffix = 2;
      while (used.has(name)) name = `${irInterface.name}_${suffix++}`;
      used.add(name);
      this.interfaceNames.set(irInterface.fqcn, name);
    }
    for (const fqcn of [...program.runtimeTypes].sort()) {
      let name = `__rt_${fqcn.replaceAll(/[^A-Za-z0-9_$]/g, "_")}`;
      let suffix = 2;
      while (used.has(name)) name = `__rt_${fqcn.replaceAll(/[^A-Za-z0-9_$]/g, "_")}_${suffix++}`;
      used.add(name);
      this.externalNames.set(fqcn, name);
    }
  }

  emit(): EmitResult {
    const files = new Map<string, string>();
    const maps = new Map<string, string>();
    const mappings = new Map<string, SourceMapping[]>();
    for (const irClass of [...this.program.classes].sort((a, b) => a.fqcn.localeCompare(b.fqcn))) {
      const file = fileName(irClass.fqcn);
      let text = this.emitClass(irClass);
      const fileMappings = this.classMappings(irClass, text);
      mappings.set(file, fileMappings);
      if (this.sourceMaps) {
        text += `//# sourceMappingURL=${file}.map\n`;
        maps.set(`${file}.map`, createSourceMap(file, this.sources, fileMappings));
      }
      files.set(file, text);
    }
    for (const irInterface of [...this.program.interfaces].sort((a, b) => a.fqcn.localeCompare(b.fqcn))) {
      const file = fileName(irInterface.fqcn);
      let text = this.emitInterface(irInterface);
      const fileMappings = irInterface.span ? [spanMapping(irInterface.span, 1)] : [];
      mappings.set(file, fileMappings);
      if (this.sourceMaps) {
        text += `//# sourceMappingURL=${file}.map\n`;
        maps.set(`${file}.map`, createSourceMap(file, this.sources, fileMappings));
      }
      files.set(file, text);
    }
    files.set(
      "index.mjs",
      [
        ...this.program.classes.map((irClass) => ({ fqcn: irClass.fqcn })),
        ...this.program.interfaces.map((irInterface) => ({ fqcn: irInterface.fqcn })),
      ]
        .sort((a, b) => a.fqcn.localeCompare(b.fqcn))
        .map((item) => `export { ${this.varName(item.fqcn)} } from "./${fileName(item.fqcn)}";`)
        .join("\n") + "\n",
    );
    return { files, maps, mappings };
  }

  /** Maps generated declaration lines back to their AS3 class/member spans. */
  private classMappings(irClass: IRClass, text: string): SourceMapping[] {
    const lines = text.split("\n");
    const result: SourceMapping[] = [];
    let cursor = 0;
    const add = (needle: string, span: typeof irClass.span): void => {
      for (let index = cursor; index < lines.length; index += 1) {
        if (!lines[index]!.startsWith(needle)) continue;
        cursor = index + 1;
        if (span) result.push(spanMapping(span, index + 1));
        return;
      }
    };
    add(`export const ${this.varName(irClass.fqcn)} = $class`, irClass.span);
    for (const accessor of irClass.accessors) add(`    ${JSON.stringify(accessor.name)}: {`, accessor.span);
    for (const method of irClass.methods) add(`    ${JSON.stringify(method.name)}: {`, method.span);
    for (const method of irClass.staticMethods) add(`    ${JSON.stringify(method.name)}: function(`, method.span);
    add("  ctor:", irClass.ctor.span);
    if (irClass.staticInit) add("  staticInit:", irClass.staticInit.span);
    return result;
  }

  private emitClass(irClass: IRClass): string {
    const refs = new Set<string>();
    if (irClass.base) refs.add(irClass.base);
    for (const interfaceFqcn of irClass.interfaces) refs.add(interfaceFqcn);
    for (const method of irClass.methods) this.collectFunction(method, refs);
    for (const method of irClass.staticMethods) this.collectFunction(method, refs);
    for (const accessor of [...irClass.accessors, ...irClass.staticAccessors]) {
      if (accessor.get) this.collectFunction(accessor.get, refs);
      if (accessor.set) this.collectFunction(accessor.set, refs);
    }
    this.collectFunction(irClass.ctor, refs);
    if (irClass.staticInit) this.collectFunction(irClass.staticInit, refs);
    for (const field of irClass.staticFields) {
      const value = irClass.staticValues[field.name];
      if (!value) continue;
      if (typeof value.value === "string" && this.classByFqcn.has(value.value)) refs.add(value.value);
    }

    const imports: string[] = [];
    for (const fqcn of [...refs].sort()) {
      if (
        fqcn === irClass.fqcn ||
        (!this.classByFqcn.has(fqcn) && !this.interfaceByFqcn.has(fqcn) && !this.externalNames.has(fqcn))
      ) continue;
      if (!this.externalNames.has(fqcn)) {
        imports.push(`import { ${this.varName(fqcn)} } from "./${fileName(fqcn)}";`);
      }
    }
    const className = this.varName(irClass.fqcn);
    const fields = irClass.fields
      .map((field) => `    ${JSON.stringify(field.name)}: { type: ${JSON.stringify(field.type)} },`)
      .join("\n");
    const accessors = irClass.accessors.map((accessor) => this.emitAccessor(accessor)).join("\n");
    const methods = irClass.methods.map((method) => this.emitMethod(method)).join("\n");
    const statics = irClass.staticMethods.map((method) => this.emitStaticMethod(method)).join("\n");
    const staticAccessors = irClass.staticAccessors
      .map((accessor) => this.emitAccessor(accessor))
      .join("\n");
    const staticValues = irClass.staticFields
      .filter((field) => irClass.staticValues[field.name] !== undefined)
      .map((field) => {
        const value = irClass.staticValues[field.name]!;
        return `    ${JSON.stringify(field.name)}: { type: ${JSON.stringify(value.type)}, value: ${constText(value.value)}, readonly: ${value.readonly} },`;
      })
      .join("\n");

    const base = irClass.base ? `() => ${this.emitRef(irClass.base)}` : "null";
    const staticInit = irClass.staticInit
      ? `\n  staticInit: ${this.emitFunction(irClass.staticInit)},`
      : "";

    return [
      `import { ${HELPERS.join(", ")} } from ${JSON.stringify(this.runtimeSpecifier)};`,
      ...imports,
      "",
      `export const ${className} = $class({`,
      `  name: ${JSON.stringify(irClass.fqcn)},`,
      "  abi: 1,",
      `  base: ${base},`,
      `  interfaces: () => [${irClass.interfaces.map((fqcn) => this.emitRef(fqcn)).join(", ")}],`,
      `  flags: { final: ${irClass.final}, dynamic: ${irClass.dynamic} },`,
      `  metadata: ${JSON.stringify(irClass.metadata)},`,
      "  fields: {",
      fields,
      "  },",
      "  accessors: {",
      accessors,
      "  },",
      "  methods: {",
      methods,
      "  },",
      "  statics: {",
      statics,
      "  },",
      "  staticAccessors: {",
      staticAccessors,
      "  },",
      "  staticValues: {",
      staticValues,
      "  },",
      `  ctor: { params: ${JSON.stringify(irClass.ctor.params.map((param) => param.type))}, fn: ${this.emitFunction(irClass.ctor)} },`,
      staticInit.replace(/^\n/, ""),
      "});",
      "",
    ].join("\n");
  }

  private nextTemp(prefix: string): string {
    this.tempIndex += 1;
    return `${prefix}${this.tempIndex}`;
  }

  private varName(fqcn: string): string {
    return this.classNames.get(fqcn) ?? this.interfaceNames.get(fqcn) ?? this.externalNames.get(fqcn) ??
      (BUILTIN_TYPES.has(fqcn) ? fqcn : fqcn.replaceAll(".", "_"));
  }

  private emitInterface(irInterface: IRInterface): string {
    const refs = new Set(irInterface.extends);
    const imports: string[] = [];
    const externalRefs = new Set<string>();
    for (const fqcn of [...refs].sort()) {
      if (this.interfaceByFqcn.has(fqcn)) {
        imports.push(`import { ${this.varName(fqcn)} } from "./${fileName(fqcn)}";`);
      } else if (this.externalNames.has(fqcn)) {
        externalRefs.add(fqcn);
      }
    }
    return [
      `import { $interface } from ${JSON.stringify(this.runtimeSpecifier)};`,
      ...imports,
      "",
      `export const ${this.varName(irInterface.fqcn)} = $interface({`,
      `  name: ${JSON.stringify(irInterface.fqcn)},`,
      "  abi: 1,",
      `  extends: () => [${irInterface.extends.map((fqcn) => this.emitRef(fqcn)).join(", ")}],`,
      "});",
      "",
    ].join("\n");
  }

  private emitAccessor(accessor: IRClass["accessors"][number]): string {
    const get = accessor.get
      ? ` get: { type: ${JSON.stringify(accessor.type)}, fn: ${this.emitFunction(accessor.get, accessor.type)} }`
      : "";
    const set = accessor.set
      ? `${get ? "," : ""} set: { type: ${JSON.stringify(accessor.type)}, fn: ${this.emitFunction(accessor.set)} }`
      : "";
    return `    ${JSON.stringify(accessor.name)}: {${get}${set} },`;
  }

  private emitMethod(method: IRMethod): string {
    return `    ${JSON.stringify(method.name)}: { params: ${JSON.stringify(method.params.map((param) => param.type))}, returns: ${JSON.stringify(method.type)}, fn: ${this.emitFunction({ params: method.params, body: method.body }, method.type)} },`;
  }

  private emitStaticMethod(method: IRMethod): string {
    return `    ${JSON.stringify(method.name)}: ${this.emitFunction({ params: method.params, body: method.body }, method.type)},`;
  }

  private emitFunction(fn: IRFunction, returnType?: string): string {
    const params = fn.params.map((param) => {
      if (param.rest) return `...${param.name}`;
      return param.defaultValue ? `${param.name} = ${this.emitExpr(param.defaultValue)}` : param.name;
    }).join(", ");
    // AS3 coerces arguments to the declared parameter type (e.g. an XMLList
    // attribute assigned to a String parameter becomes its text value).
    const coercions = fn.params
      .filter((param) => !param.rest && COERCIBLE_PARAM_TYPES.has(param.type))
      .map((param) => `    ${param.name} = $coerce(${param.name}, ${JSON.stringify(param.type)});`);
    const outerLocals = this.localTypes;
    const outerReturn = this.returnType;
    this.localTypes = new Map();
    this.returnType = returnType;
    for (const param of fn.params) {
      if (!param.rest && COERCIBLE_PARAM_TYPES.has(param.type)) this.localTypes.set(param.name, param.type);
    }
    for (const stmt of fn.body) this.collectTypedLocals(stmt, this.localTypes);
    try {
      const body = [...coercions, ...fn.body.map((stmt) => this.emitStmt(stmt, 4))];
      if (body.length === 0) return `function(${params}) {}`;
      return `function(${params}) {\n${body.join("\n")}\n  }`;
    } finally {
      this.localTypes = outerLocals;
      this.returnType = outerReturn;
    }
  }

  /** Declared return type of the function being emitted, for return coercion. */
  private returnType?: string;

  /** Declared type of each local in the function being emitted, for assignment coercion. */
  private localTypes = new Map<string, string>();

  private collectTypedLocals(stmt: IRStmt, into: Map<string, string>): void {
    const node = stmt as any;
    if (node.k === "function") return;
    if (node.k === "var" && COERCIBLE_PARAM_TYPES.has(node.type)) into.set(node.name, node.type);
    if (node.k === "forIn" && node.declaration && COERCIBLE_PARAM_TYPES.has(node.declaration.type)) {
      into.set(node.declaration.name, node.declaration.type);
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object" && typeof item.k === "string") {
            this.collectTypedLocals(item as IRStmt, into);
          }
        }
      } else if (value && typeof value === "object" && typeof value.k === "string") {
        this.collectTypedLocals(value as IRStmt, into);
      }
    }
  }

  /** AS3 coerces a typed local's initializer, e.g. `var name:String = xml.attribute("name")`. */
  private emitTypedInit(init: IRExpr, type: string): string {
    const value = this.emitExpr(init);
    return type && COERCIBLE_PARAM_TYPES.has(type)
      ? `$coerce(${value}, ${JSON.stringify(type)})`
      : value;
  }

  private emitStmt(stmt: IRStmt, indent: number): string {
    const pad = " ".repeat(indent);
    switch (stmt.k) {
      case "block":
        if (stmt.body.length === 0) return "{}";
        return `{\n${stmt.body.map((child) => this.emitStmt(child, indent + 2)).join("\n")}\n${pad.slice(2)}}`;
      case "var":
        return `${pad}${stmt.const ? "const" : "var"} ${stmt.name}${stmt.init ? ` = ${this.emitTypedInit(stmt.init, stmt.type)}` : ""};`;
      case "expr":
        return `${pad}${this.emitExpr(stmt.expr)};`;
      case "if": {
        const nested = indent + 2;
        const then = this.emitStmt(stmt.then, nested);
        const otherwise = stmt.else ? `\n${pad}else ${this.emitStmt(stmt.else, nested)}` : "";
        return `${pad}if (${this.emitExpr(stmt.test)}) ${then}${otherwise}`;
      }
      case "while":
        return `${pad}while (${this.emitExpr(stmt.test)}) ${this.emitStmt(stmt.body, indent + 2)}`;
      case "do":
        return `${pad}do ${this.emitStmt(stmt.body, indent + 2)}\n${pad}while (${this.emitExpr(stmt.test)});`;
      case "for": {
        const init = stmt.init.map((item) => {
          if (item.k === "var") return `${item.const ? "const" : "var"} ${item.name}${item.init ? ` = ${this.emitExpr(item.init)}` : ""}`;
          if (item.k === "expr") return this.emitExpr(item.expr);
          return "";
        }).join(", ");
        return `${pad}for (${init}; ${stmt.test ? this.emitExpr(stmt.test) : ""}; ${stmt.update ? this.emitExpr(stmt.update) : ""}) ${this.emitStmt(stmt.body, indent + 2)}`;
      }
      case "return": {
        // Flash coerces the result to the declared return type (e.g. a String
        // method returning a number yields its text form).
        const value = stmt.value;
        const coerced = value
          ? this.returnType && COERCIBLE_PARAM_TYPES.has(this.returnType)
            ? `$coerce(${this.emitExpr(value)}, ${JSON.stringify(this.returnType)})`
            : this.emitExpr(value)
          : null;
        return `${pad}return${coerced === null ? "" : ` ${coerced}`};`;
      }
      case "break":
        return `${pad}break${stmt.label ? ` ${stmt.label}` : ""};`;
      case "continue":
        return `${pad}continue${stmt.label ? ` ${stmt.label}` : ""};`;
      case "label":
        return `${pad}${stmt.label}: ${this.emitStmt(stmt.body, 0)}`;
      case "forIn": {
        const helper = stmt.each ? "$forEach" : "$forIn";
        const source = `${helper}(${this.emitExpr(stmt.iterable)})`;
        if (stmt.declaration) {
          return `${pad}for (var ${stmt.declaration.name} of ${source}) ${this.emitStmt(stmt.body, indent + 2)}`;
        }
        const temp = this.nextTemp("__item");
        const target = stmt.target;
        if (!target) throw new Error("IR forIn without declaration or target");
        const body: IRStmt[] = [
          { k: "expr", expr: { k: "assign", target, op: "=", value: { k: "local", name: temp } } },
          stmt.body,
        ];
        return `${pad}for (const ${temp} of ${source}) ${this.emitStmt({ k: "block", body }, indent + 2)}`;
      }
      case "throw":
        return `${pad}throw ${this.emitExpr(stmt.value)};`;
      case "try": {
        const block = this.emitStmt({ k: "block", body: stmt.body }, indent);
        const finallyBlock = stmt.finalizer
          ? `\n${pad}finally ${this.emitStmt({ k: "block", body: stmt.finalizer }, indent)}`
          : "";
        if (stmt.catches.length === 0) return `${pad}try ${block}${finallyBlock}`;
        const name = "__caught";
        const chain = stmt.catches.map((clause, index) => {
          const test = clause.type === null || clause.type === "*" || clause.type === "Object"
            ? "true"
            : `$is(${name}, ${this.emitType(clause.type)})`;
          const prefix = index === 0 ? "if" : "else if";
          const body = clause.name === name
            ? clause.body
            : [{ k: "var" as const, name: clause.name, type: "*", init: { k: "local" as const, name }, const: true }, ...clause.body];
          return `${pad}  ${prefix} (${test}) ${this.emitStmt({ k: "block", body }, indent + 4)}`;
        });
        chain.push(`${pad}  else { throw ${name}; }`);
        return `${pad}try ${block}\n${pad}catch (${name}) {\n${chain.join("\n")}\n${pad}}${finallyBlock}`;
      }
      case "switch": {
        const casePad = " ".repeat(indent + 2);
        const cases = stmt.cases.map((item) => {
          const label = item.test ? `case ${this.emitExpr(item.test)}:` : "default:";
          const body = item.body.map((child) => this.emitStmt(child, indent + 4)).join("\n");
          return `${casePad}${label}${body ? `\n${body}` : ""}`;
        });
        return `${pad}switch (${this.emitExpr(stmt.discriminant)}) {\n${cases.join("\n")}\n${pad}}`;
      }
      case "empty":
        return `${pad};`;
    }
  }

  private emitExpr(expr: IRExpr): string {
    switch (expr.k) {
      case "const":
        return constText(expr.value);
      case "this":
        return "this";
      case "local":
        return expr.name;
      case "global":
        return expr.name;
      case "classRef": {
        const value = this.emitRef(expr.fqcn);
        return `($ensureInit(${value}), ${value})`;
      }
      case "runtimeClass":
        return `$runtimeClass(${JSON.stringify(expr.fqcn)})`;
      case "runtimeValue":
        return `$runtimeValue(${JSON.stringify(expr.name)})`;
      case "xmlAttribute":
        return `$xmlAttribute(${this.emitExpr(expr.object)}, ${JSON.stringify(expr.property)})`;
      case "xmlSetAttribute":
        return `$xmlSetAttribute(${this.emitExpr(expr.object)}, ${JSON.stringify(expr.property)}, ${this.emitExpr(expr.value)})`;
      case "xmlDescendants":
        return `$xmlDescendants(${this.emitExpr(expr.object)}, ${JSON.stringify(expr.property)})`;
      case "xmlFilter":
        return `$xmlFilter(${this.emitExpr(expr.object)}, ${this.emitFunction(expr.predicate)})`;
      case "xmlLiteral":
        return `$xmlLiteral(${JSON.stringify(expr.value)})`;
      case "regex":
        return `(${expr.raw})`;
      case "member": {
        const object = this.emitStaticObject(expr.object);
        if (expr.bound) {
          // Private methods are bound to their declaring class; AS3 does not dispatch them
          // through a subclass that declares a method with the same name.
          const owner = expr.bindTo ? `, ${JSON.stringify(expr.bindTo)}` : "";
          return `$bindMethod(${object}, ${JSON.stringify(expr.property)}${owner})`;
        }
        return isIdentifier(expr.property)
          ? `${object}.${expr.property}`
          : `${object}[${JSON.stringify(expr.property)}]`;
      }
      case "index":
        return `$index(${this.emitExpr(expr.object)}, ${this.emitExpr(expr.index)})`;
      case "call":
        return `${this.emitExpr(expr.callee)}(${expr.args.map((arg) => this.emitExpr(arg)).join(", ")})`;
      case "construct":
        return `new ${this.emitStaticObject(expr.classRef)}(${expr.args.map((arg) => this.emitExpr(arg)).join(", ")})`;
      case "superCall": {
        const base = this.emitRef(expr.base);
        const args = `[${expr.args.map((arg) => this.emitExpr(arg)).join(", ")}]`;
        return expr.name === null
          ? `$super(this, ${base}, ${args})`
          : `$superCall(this, ${base}, ${JSON.stringify(expr.name)}, ${args})`;
      }
      case "superGet":
        return `$superGet(this, ${this.emitRef(expr.base)}, ${JSON.stringify(expr.property)})`;
      case "superSet":
        return `$superSet(this, ${this.emitRef(expr.base)}, ${JSON.stringify(expr.property)}, ${this.emitExpr(expr.value)})`;
      case "superUpdate":
        return `$superUpdate(this, ${this.emitRef(expr.base)}, ${JSON.stringify(expr.property)}, ${JSON.stringify(expr.op)}, ${expr.prefix})`;
      case "binary":
        if (expr.op === "in") {
          // Dictionary keys and flash_proxy hasProperty do not exist as JS properties.
          return `$in(${this.emitExpr(expr.left)}, ${this.emitExpr(expr.right)})`;
        }
        return `(${this.emitExpr(expr.left)} ${expr.op} ${this.emitExpr(expr.right)})`;
      case "unary":
        if (expr.op === "delete") {
          if (expr.operand.k === "index") {
            return `$indexDelete(${this.emitExpr(expr.operand.object)}, ${this.emitExpr(expr.operand.index)})`;
          }
          if (expr.operand.k === "member") {
            // Declared members are sealed in AS3; deleting one returns false and keeps it.
            return `$deleteMember(${this.emitExpr(expr.operand.object)}, ${JSON.stringify(expr.operand.property)})`;
          }
          // `delete` is a word operator: it needs a space before its operand.
          return `(delete ${this.emitExpr(expr.operand)})`;
        }
        // AS3 reports "xml" for XML/XMLList and "object" for class references.
        if (expr.op === "typeof") return `$typeof(${this.emitExpr(expr.operand)})`;
        // `void` is a word operator, so it needs a space before a `this` operand.
        if (expr.op === "void") return `(void ${this.emitExpr(expr.operand)})`;
        return `${expr.op}${this.emitExpr(expr.operand)}`;
      case "update":
        if (expr.operand.k === "index") {
          return `$indexUpdate(${this.emitExpr(expr.operand.object)}, ${this.emitExpr(expr.operand.index)}, ${JSON.stringify(expr.op)}, ${expr.prefix})`;
        }
        if (expr.operand.k === "local" && this.localTypes.has(expr.operand.name)) {
          // `++` writes back through the declared slot, so an int wraps at 32 bits. Postfix
          // keeps its old value, which an inline arrow can hold without a temp local.
          const name = expr.operand.name;
          const declared = JSON.stringify(this.localTypes.get(name));
          const arithmetic = expr.op === "++" ? "+" : "-";
          const next = (value: string): string => `$coerce(${value} ${arithmetic} 1, ${declared})`;
          return expr.prefix
            ? `(${name} = ${next(name)})`
            : `((previous) => (${name} = ${next("previous")}, previous))(${name})`;
        }
        return expr.prefix
          ? `(${expr.op}${this.emitExpr(expr.operand)})`
          : `(${this.emitExpr(expr.operand)}${expr.op})`;
      case "conditional":
        return `(${this.emitExpr(expr.test)} ? ${this.emitExpr(expr.then)} : ${this.emitExpr(expr.else)})`;
      case "assign":
        if (expr.target.k === "index") {
          const object = this.emitExpr(expr.target.object);
          const key = this.emitExpr(expr.target.index);
          if (expr.op === "=") return `$indexSet(${object}, ${key}, ${this.emitExpr(expr.value)})`;
          return `$indexSet(${object}, ${key}, ($index(${object}, ${key}) ${expr.op.slice(0, -1)} ${this.emitExpr(expr.value)}))`;
        }
        if (expr.target.k === "local" && expr.op !== "&&=" && expr.op !== "||=") {
          // Flash coerces every assignment to the variable's declared type, so a String local
          // assigned an XMLList holds its text value and `i += 0.5` on an int truncates.
          const declared = this.localTypes.get(expr.target.name);
          if (declared) {
            const value = this.emitExpr(expr.value);
            const name = expr.target.name;
            const assigned = expr.op === "=" ? value : `(${name} ${expr.op.slice(0, -1)} ${value})`;
            return `(${name} = $coerce(${assigned}, ${JSON.stringify(declared)}))`;
          }
        }
        return `(${this.emitExpr(expr.target)} ${expr.op} ${this.emitExpr(expr.value)})`;
      case "array":
        return `[${expr.values.map((value) => this.emitExpr(value)).join(", ")}]`;
      case "object":
        return `{ ${expr.entries.map(([key, value]) => `${JSON.stringify(key)}: ${this.emitExpr(value)}`).join(", ")} }`;
      case "cast":
        return `$cast(${this.emitExpr(expr.value)}, ${this.emitType(expr.type)})`;
      case "is":
        return `$is(${this.emitExpr(expr.value)}, ${this.emitType(expr.type)})`;
      case "coerce":
        return `$coerce(${this.emitExpr(expr.value)}, ${this.emitType(expr.type)})`;
      case "vector": {
        const values = `[${expr.values.map((value) => this.emitExpr(value)).join(", ")}]`;
        const length = expr.length ? `, ${this.emitExpr(expr.length)}` : "";
        return `$vector(${this.emitType(expr.element)}, ${values}${length})`;
      }
      case "vectorCast":
        return `$vectorCast(${this.emitExpr(expr.value)}, ${this.emitType(expr.element)})`;
      case "sequence":
        return `(${expr.expressions.map((value) => this.emitExpr(value)).join(", ")})`;
      case "function":
        return `(${this.emitFunction({ params: expr.params, body: expr.body })}).bind(this)`;
    }
  }

  private emitStaticObject(expr: IRExpr): string {
    return this.emitExpr(expr);
  }

  private emitRef(fqcn: string): string {
    if (this.classByFqcn.has(fqcn) || this.interfaceByFqcn.has(fqcn)) return this.varName(fqcn);
    if (this.externalNames.has(fqcn)) return `$runtimeClass(${JSON.stringify(fqcn)})`;
    if (BUILTIN_TYPES.has(fqcn)) return fqcn;
    return `$runtimeClass(${JSON.stringify(fqcn)})`;
  }

  private emitType(type: string): string {
    if (this.classByFqcn.has(type) || this.interfaceByFqcn.has(type) || this.externalNames.has(type)) return this.emitRef(type);
    return JSON.stringify(type);
  }

  private collectFunction(fn: IRFunction, refs: Set<string>): void {
    for (const statement of fn.body) this.collectStmt(statement, refs);
  }

  private collectStmt(stmt: IRStmt, refs: Set<string>): void {
    switch (stmt.k) {
      case "block":
        for (const child of stmt.body) this.collectStmt(child, refs);
        return;
      case "var":
        if (stmt.init) this.collectExpr(stmt.init, refs);
        return;
      case "expr":
        this.collectExpr(stmt.expr, refs);
        return;
      case "if":
        this.collectExpr(stmt.test, refs);
        this.collectStmt(stmt.then, refs);
        if (stmt.else) this.collectStmt(stmt.else, refs);
        return;
      case "while":
        this.collectExpr(stmt.test, refs);
        this.collectStmt(stmt.body, refs);
        return;
      case "do":
        this.collectStmt(stmt.body, refs);
        this.collectExpr(stmt.test, refs);
        return;
      case "for":
        for (const init of stmt.init) this.collectStmt(init, refs);
        if (stmt.test) this.collectExpr(stmt.test, refs);
        if (stmt.update) this.collectExpr(stmt.update, refs);
        this.collectStmt(stmt.body, refs);
        return;
      case "return":
        if (stmt.value) this.collectExpr(stmt.value, refs);
        return;
      case "throw":
        this.collectExpr(stmt.value, refs);
        return;
      case "label":
        this.collectStmt(stmt.body, refs);
        return;
      case "forIn":
        this.collectExpr(stmt.iterable, refs);
        if (stmt.target) this.collectExpr(stmt.target, refs);
        this.collectStmt(stmt.body, refs);
        return;
      case "try":
        for (const child of stmt.body) this.collectStmt(child, refs);
        for (const clause of stmt.catches) {
          if (clause.type && (this.classByFqcn.has(clause.type) || this.interfaceByFqcn.has(clause.type) || this.externalNames.has(clause.type))) {
            refs.add(clause.type);
          }
          for (const child of clause.body) this.collectStmt(child, refs);
        }
        if (stmt.finalizer) for (const child of stmt.finalizer) this.collectStmt(child, refs);
        return;
      case "switch":
        this.collectExpr(stmt.discriminant, refs);
        for (const item of stmt.cases) {
          if (item.test) this.collectExpr(item.test, refs);
          for (const child of item.body) this.collectStmt(child, refs);
        }
        return;
      case "break":
      case "continue":
      case "empty":
        return;
    }
  }

  private collectExpr(expr: IRExpr, refs: Set<string>): void {
    switch (expr.k) {
      case "classRef":
        refs.add(expr.fqcn);
        return;
      case "member":
        this.collectExpr(expr.object, refs);
        return;
      case "xmlAttribute":
        this.collectExpr(expr.object, refs);
        return;
      case "xmlSetAttribute":
        this.collectExpr(expr.object, refs);
        this.collectExpr(expr.value, refs);
        return;
      case "xmlFilter":
        this.collectExpr(expr.object, refs);
        for (const statement of expr.predicate.body) this.collectStmt(statement, refs);
        return;
      case "index":
        this.collectExpr(expr.object, refs);
        this.collectExpr(expr.index, refs);
        return;
      case "call":
        this.collectExpr(expr.callee, refs);
        for (const arg of expr.args) this.collectExpr(arg, refs);
        return;
      case "construct":
        this.collectExpr(expr.classRef, refs);
        for (const arg of expr.args) this.collectExpr(arg, refs);
        return;
      case "superCall":
        refs.add(expr.base);
        for (const arg of expr.args) this.collectExpr(arg, refs);
        return;
      case "superGet":
      case "superSet":
      case "superUpdate":
        refs.add(expr.base);
        if (expr.k === "superSet") this.collectExpr(expr.value, refs);
        return;
      case "binary":
        this.collectExpr(expr.left, refs);
        this.collectExpr(expr.right, refs);
        return;
      case "unary":
        this.collectExpr(expr.operand, refs);
        return;
      case "update":
        this.collectExpr(expr.operand, refs);
        return;
      case "conditional":
        this.collectExpr(expr.test, refs);
        this.collectExpr(expr.then, refs);
        this.collectExpr(expr.else, refs);
        return;
      case "assign":
        this.collectExpr(expr.target, refs);
        this.collectExpr(expr.value, refs);
        return;
      case "array":
        for (const value of expr.values) this.collectExpr(value, refs);
        return;
      case "object":
        for (const [, value] of expr.entries) this.collectExpr(value, refs);
        return;
      case "cast":
      case "is":
        this.collectExpr(expr.value, refs);
        if (this.classByFqcn.has(expr.type) || this.interfaceByFqcn.has(expr.type) || this.externalNames.has(expr.type)) refs.add(expr.type);
        return;
      case "coerce":
        this.collectExpr(expr.value, refs);
        return;
      case "vector":
        for (const value of expr.values) this.collectExpr(value, refs);
        if (expr.length) this.collectExpr(expr.length, refs);
        return;
      case "vectorCast":
        this.collectExpr(expr.value, refs);
        if (this.classByFqcn.has(expr.element) || this.interfaceByFqcn.has(expr.element) || this.externalNames.has(expr.element)) refs.add(expr.element);
        return;
      case "sequence":
        for (const value of expr.expressions) this.collectExpr(value, refs);
        return;
      case "function":
        for (const statement of expr.body) this.collectStmt(statement, refs);
        return;
      case "regex":
      case "const":
      case "this":
      case "local":
      case "global":
        return;
    }
  }
}

export function emitProject(program: IRProgram, options: EmitOptions = {}): EmitResult {
  return new Emitter(program, options).emit();
}