import type {
  ArrayLiteral,
  AttributeSelectorExpression,
  BlockStatement,
  ClassDeclaration,
  ClassMember,
  Expression,
  FieldDeclaration,
  ForInStatement,
  ForStatement,
  FunctionDeclarationStatement,
  FunctionExpression,
  Identifier,
  IfStatement,
  ImportDeclaration,
  InterfaceDeclaration,
  LabeledStatement,
  MemberAccess,
  MemberExpression,
  Metadata,
  MetadataArgument,
  MetadataValue,
  MethodDeclaration,
  Modifier,
  NamespaceDeclaration,
  NewExpression,
  ObjectLiteral,
  Parameter,
  ParenthesizedExpression,
  Program,
  QualifiedNameExpression,
  ReturnStatement,
  SequenceExpression,
  Statement,
  SwitchCase,
  SwitchStatement,
  TopLevelDeclaration,
  TryStatement,
  TypeNode,
  UnaryExpression,
  VariableDeclaration,
  VariableStatement,
  VectorTypeExpression,
  XmlFilterExpression,
} from "../ast.ts";
import { diag, span, type Diagnostic, type Span } from "../diagnostics.ts";
import { Lexer } from "../lexer/lexer.ts";
import type { Token } from "../lexer/token.ts";

const MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "final",
  "override",
  "dynamic",
  "native",
]);

const ASSIGNMENT_OPERATORS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "||=",
  "&&=",
]);

const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "===": 6,
  "!==": 6,
  "<": 7,
  ">": 7,
  "<=": 7,
  ">=": 7,
  in: 7,
  instanceof: 7,
  is: 7,
  as: 7,
  "<<": 8,
  ">>": 8,
  ">>>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
};

class TokenStream {
  readonly tokens: Token[];
  readonly file: string;
  private index = 0;
  readonly diagnostics: Diagnostic[] = [];

  constructor(tokens: Token[], file: string) {
    this.tokens = tokens;
    this.file = file;
  }

  get pos(): number {
    return this.index;
  }

  get current(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  peek(offset = 1): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)]!;
  }

  at(text: string): boolean {
    return this.current.text === text;
  }

  atKind(kind: Token["kind"]): boolean {
    return this.current.kind === kind;
  }

  eof(): boolean {
    return this.current.kind === "eof";
  }

  next(): Token {
    const token = this.current;
    if (this.index < this.tokens.length - 1) this.index++;
    return token;
  }

  match(text: string): boolean {
    if (!this.at(text)) return false;
    this.next();
    return true;
  }

  expect(text: string, message?: string): boolean {
    if (this.at(text)) {
      this.next();
      return true;
    }
    this.error("PAR001", message ?? `Expected '${text}' but found '${this.describe()}'`);
    return false;
  }

  expectWord(message = "Expected an identifier"): string {
    if (this.current.kind === "word") return this.next().text;
    this.error("PAR002", `${message} but found '${this.describe()}'`);
    return "<missing>";
  }

  error(code: string, message: string, token = this.current): void {
    this.diagnostics.push(diag("error", code, message, this.tokenSpan(token)));
  }

  tokenSpan(token: Token): Span {
    return span(this.file, token.start, token.end, token.line, token.column);
  }

  /** Split one leading '>' out of '>>', '>>>' or '>=' for type arguments. */
  splitGreater(): boolean {
    return this.splitLeading(">");
  }

  /** Split a leading token fragment, e.g. `*=` into `*` + `=`. */
  splitLeading(prefix: string): boolean {
    const token = this.current;
    if (token.text.length > prefix.length && token.text.startsWith(prefix)) {
      this.tokens[this.index] = {
        ...token,
        text: token.text.slice(prefix.length),
        start: token.start + prefix.length,
        column: token.column + prefix.length,
      };
      return true;
    }
    return false;
  }

  describe(): string {
    if (this.current.kind === "eof") return "end of file";
    return this.current.text;
  }
}

export interface ParseResult {
  program: Program;
  diagnostics: Diagnostic[];
  tokens: Token[];
}

export function parseSource(source: string, file = "<input>"): ParseResult {
  const lexed = new Lexer(source, file).tokenize();
  const parser = new Parser(lexed.tokens, file);
  const program = parser.parseProgram();
  const diagnostics = [...lexed.diagnostics, ...parser.diagnostics].sort(
    (a, b) => a.span.start - b.span.start,
  );
  return { program, diagnostics, tokens: lexed.tokens };
}

export class Parser {
  private readonly ts: TokenStream;
  readonly diagnostics: Diagnostic[];

  constructor(tokens: Token[], file = "<input>") {
    this.ts = new TokenStream(tokens, file);
    this.diagnostics = this.ts.diagnostics;
  }

  parseProgram(): Program {
    const start = this.ts.current;
    let packageName: string | null = null;
    const imports: ImportDeclaration[] = [];
    const declarations: TopLevelDeclaration[] = [];

    if (this.ts.match("package")) {
      if (!this.ts.at("{")) packageName = this.parseQualifiedName();
      this.ts.expect("{");
      this.parsePackageBody(imports, declarations);
      this.ts.expect("}");
    } else {
      this.parsePackageBody(imports, declarations);
    }

    // Some decompiled files place imports/classes after the package block. Treat that
    // trailing text as part of the same compilation unit rather than silently stopping.
    if (!this.ts.eof()) this.parsePackageBody(imports, declarations);

    return {
      kind: "Program",
      packageName,
      imports,
      declarations,
      span: this.spanFromToken(start),
    };
  }

  private parsePackageBody(
    imports: ImportDeclaration[],
    declarations: TopLevelDeclaration[],
  ): void {
    while (!this.ts.eof() && !this.ts.at("}")) {
      const before = this.ts.pos;
      if (this.ts.at("import")) {
        imports.push(this.parseImport());
      } else if (this.ts.at("use") && this.ts.peek().text === "namespace") {
        this.parseUseNamespace();
      } else if (this.isTopLevelDeclarationStart()) {
        declarations.push(this.parseTopLevelDeclaration());
      } else {
        this.ts.diagnostics.push(
          diag(
            "warning",
            "PAR020",
            `Ignoring unexpected package-scope token '${this.ts.describe()}'`,
            this.ts.tokenSpan(this.ts.current),
          ),
        );
        this.skipTopLevelElement();
      }
      if (this.ts.pos === before) this.ts.next();
    }
  }

  private isTopLevelDeclarationStart(): boolean {
    return (
      this.ts.at("[") ||
      this.ts.at("class") ||
      this.ts.at("interface") ||
      this.ts.at("namespace") ||
      (this.ts.current.kind === "word" && MODIFIERS.has(this.ts.current.text))
    );
  }

  private parseTopLevelDeclaration(): TopLevelDeclaration {
    const metadata = this.parseMetadataList();
    const modifiers = this.parseModifiers();
    const start = this.ts.current;

    if (this.ts.at("class")) return this.parseClass(metadata, modifiers);
    if (this.ts.at("interface")) return this.parseInterface(metadata, modifiers);
    if (this.ts.at("namespace")) return this.parseNamespace(metadata, modifiers, null);

    this.ts.error("PAR004", "Expected a class, interface or namespace declaration");
    this.skipTopLevelElement();
    return this.emptyClass(start);
  }

  private parseClass(metadata: Metadata[], modifiers: Modifier[]): ClassDeclaration {
    const start = this.ts.current;
    this.ts.expect("class");
    const name = this.ts.expectWord("Expected a class name");
    const extendsType = this.ts.match("extends") ? this.parseType() : null;
    const implementsTypes: TypeNode[] = [];
    if (this.ts.match("implements")) {
      do {
        implementsTypes.push(this.parseType());
      } while (this.ts.match(","));
    }
    this.ts.expect("{");
    const members: ClassMember[] = [];
    while (!this.ts.eof() && !this.ts.at("}")) {
      const before = this.ts.pos;
      members.push(...this.parseClassMember(name));
      if (this.ts.pos === before) this.ts.next();
    }
    this.ts.expect("}");
    return {
      kind: "ClassDeclaration",
      name,
      modifiers,
      metadata,
      extends: extendsType,
      implements: implementsTypes,
      members,
      span: this.spanFromToken(start),
    };
  }

  private parseInterface(metadata: Metadata[], modifiers: Modifier[]): InterfaceDeclaration {
    const start = this.ts.current;
    this.ts.expect("interface");
    const name = this.ts.expectWord("Expected an interface name");
    const extendsTypes: TypeNode[] = [];
    if (this.ts.match("extends")) {
      do {
        extendsTypes.push(this.parseType());
      } while (this.ts.match(","));
    }
    this.ts.expect("{");
    const members: ClassMember[] = [];
    while (!this.ts.eof() && !this.ts.at("}")) {
      const before = this.ts.pos;
      members.push(...this.parseClassMember(name));
      if (this.ts.pos === before) this.ts.next();
    }
    this.ts.expect("}");
    return {
      kind: "InterfaceDeclaration",
      name,
      modifiers,
      metadata,
      extends: extendsTypes,
      members,
      span: this.spanFromToken(start),
    };
  }

  private parseClassMember(className: string): ClassMember[] {
    const metadata = this.parseMetadataList();
    const modifiers = this.parseModifiers();

    if (this.ts.at("use") && this.ts.peek().text === "namespace") {
      this.parseUseNamespace();
      return [];
    }

    let namespace: string | null = null;
    if (
      this.ts.current.kind === "word" &&
      !["var", "const", "function", "namespace", "use"].includes(this.ts.current.text) &&
      ["var", "const", "function", "namespace"].includes(this.ts.peek().text)
    ) {
      namespace = this.ts.next().text;
    }

    if (this.ts.at("var") || this.ts.at("const")) {
      return this.parseFields(metadata, modifiers, namespace);
    }
    if (this.ts.at("function")) {
      return [this.parseMethod(metadata, modifiers, className, namespace)];
    }
    if (this.ts.at("namespace")) {
      return [this.parseNamespace(metadata, modifiers, namespace)];
    }
    if (this.ts.at("{")) {
      const start = this.ts.current;
      const body = this.parseBlock();
      return [
        {
          kind: "ClassInitializer",
          body,
          modifiers,
          metadata,
          span: this.spanFromToken(start),
        },
      ];
    }
    if (this.ts.at(";")) {
      this.ts.next();
      return [];
    }

    this.ts.error("PAR005", `Expected a class member but found '${this.ts.describe()}'`);
    this.skipMember();
    return [];
  }

  private parseFields(
    metadata: Metadata[],
    modifiers: Modifier[],
    namespace: string | null,
  ): FieldDeclaration[] {
    this.ts.next(); // var / const
    const isConst = this.ts.previous().text === "const";
    const fields: FieldDeclaration[] = [];
    do {
      const declStart = this.ts.current;
      const name = this.ts.expectWord("Expected a field name");
      const type = this.ts.match(":") ? this.parseType() : null;
      const initializer = this.ts.match("=") ? this.parseAssignment() : null;
      fields.push({
        kind: "FieldDeclaration",
        name,
        isConst,
        type,
        initializer,
        modifiers,
        metadata,
        ...(namespace ? { namespace } : {}),
        span: this.spanFromToken(declStart),
      });
    } while (this.ts.match(","));
    this.consumeSemicolon();
    return fields;
  }

  private parseMethod(
    metadata: Metadata[],
    modifiers: Modifier[],
    className: string,
    namespace: string | null,
  ): MethodDeclaration {
    const start = this.ts.current;
    this.ts.expect("function");
    let accessor: "get" | "set" | null = null;
    if (
      (this.ts.at("get") || this.ts.at("set")) &&
      this.ts.peek().kind === "word" &&
      this.ts.peek().text !== "("
    ) {
      accessor = this.ts.next().text as "get" | "set";
    }
    const name = this.ts.expectWord("Expected a method name");
    const params = this.parseParameters();
    const returnType = this.ts.match(":") ? this.parseType() : null;
    let body: BlockStatement | null = null;
    if (this.ts.at("{")) {
      body = this.parseBlock();
    } else {
      this.ts.expect(";");
    }
    return {
      kind: "MethodDeclaration",
      name,
      accessor,
      isConstructor: name === className && accessor === null,
      params,
      returnType,
      body,
      modifiers,
      metadata,
      ...(namespace ? { namespace } : {}),
      span: this.spanFromToken(start),
    };
  }

  private parseNamespace(
    metadata: Metadata[],
    modifiers: Modifier[],
    namespace: string | null,
  ): NamespaceDeclaration {
    const start = this.ts.current;
    this.ts.expect("namespace");
    const name = this.ts.expectWord("Expected a namespace name");
    const value = this.ts.match("=") ? this.parseStringValue() : null;
    this.consumeSemicolon();
    void metadata;
    return {
      kind: "NamespaceDeclaration",
      name,
      value,
      modifiers,
      ...(namespace ? { namespace } : {}),
      span: this.spanFromToken(start),
    };
  }

  private parseImport(): ImportDeclaration {
    const start = this.ts.current;
    this.ts.expect("import");
    const { name, wildcard } = this.parseQualifiedNameWithWildcard();
    this.consumeSemicolon();
    return {
      kind: "ImportDeclaration",
      name,
      wildcard,
      span: this.spanFromToken(start),
    };
  }

  private parseUseNamespace(): void {
    this.ts.expect("use");
    this.ts.expect("namespace");
    this.parseQualifiedName();
    this.consumeSemicolon();
  }

  private parseMetadataList(): Metadata[] {
    const result: Metadata[] = [];
    while (this.ts.at("[")) {
      const start = this.ts.current;
      this.ts.next();
      const name = this.ts.expectWord("Expected a metadata name");
      const args: MetadataArgument[] = [];
      if (this.ts.match("(")) {
        while (!this.ts.eof() && !this.ts.at(")")) {
          const argStart = this.ts.current;
          let argName: string | null = null;
          if (this.ts.current.kind === "word" && this.ts.peek().text === "=") {
            argName = this.ts.next().text;
            this.ts.next();
          }
          const value = this.parseMetadataValue();
          args.push({
            kind: "MetadataArgument",
            name: argName,
            value,
            span: this.spanFromToken(argStart),
          });
          if (!this.ts.match(",")) break;
        }
        this.ts.expect(")");
      }
      this.ts.expect("]");
      result.push({
        kind: "Metadata",
        name,
        args,
        raw: name,
        span: this.spanFromToken(start),
      });
    }
    return result;
  }

  private parseMetadataValue(): MetadataValue {
    if (this.ts.current.kind === "string") return this.parseStringValue();
    if (this.ts.current.kind === "number") return Number(this.ts.next().text);
    if (this.ts.at("true")) {
      this.ts.next();
      return true;
    }
    if (this.ts.at("false")) {
      this.ts.next();
      return false;
    }
    if (this.ts.at("null")) {
      this.ts.next();
      return null;
    }
    if (this.ts.at("[")) {
      this.ts.next();
      const values: MetadataValue[] = [];
      while (!this.ts.eof() && !this.ts.at("]")) {
        values.push(this.parseMetadataValue());
        if (!this.ts.match(",")) break;
      }
      this.ts.expect("]");
      return { kind: "ArrayValue", values };
    }
    if (this.ts.current.kind === "word") {
      return { kind: "IdentifierValue", name: this.ts.next().text };
    }
    this.ts.error("PAR006", "Expected a metadata value");
    if (!this.ts.eof()) this.ts.next();
    return null;
  }

  /* --------------------------------------------------------------------- */
  /* Statements                                                            */
  /* --------------------------------------------------------------------- */

  private parseStatement(): Statement {
    const start = this.ts.current;

    if (this.ts.at("{")) return this.parseBlock();
    if (this.ts.at(";")) {
      this.ts.next();
      return { kind: "EmptyStatement", span: this.spanFromToken(start) };
    }
    if (this.ts.at("var") || this.ts.at("const")) return this.parseVariableStatement();
    if (this.ts.at("if")) return this.parseIf();
    if (this.ts.at("while")) return this.parseWhile();
    if (this.ts.at("do")) return this.parseDoWhile();
    if (this.ts.at("for")) return this.parseFor();
    if (this.ts.at("switch")) return this.parseSwitch();
    if (this.ts.at("try")) return this.parseTry();
    if (this.ts.at("throw")) return this.parseThrow();
    if (this.ts.at("return")) return this.parseReturn();
    if (this.ts.at("break")) return this.parseBreak();
    if (this.ts.at("continue")) return this.parseContinue();
    if (this.ts.at("function")) return this.parseFunctionDeclarationStatement();
    if (this.ts.at("default") && this.ts.peek().text === "xml") {
      this.ts.error("PAR007", "`default xml namespace` is not supported yet");
      this.skipToSemicolon();
      return { kind: "EmptyStatement", span: this.spanFromToken(start) };
    }
    if (this.ts.at("with")) {
      this.ts.next();
      this.ts.expect("(");
      const object = this.parseExpression();
      this.ts.expect(")");
      const body = this.parseStatement();
      this.ts.diagnostics.push(
        diag(
          "warning",
          "PAR008",
          "`with` is parsed but unsupported; the semantic phase will reject it",
          this.ts.tokenSpan(start),
        ),
      );
      return { kind: "WithStatement", object, body, span: this.spanFromToken(start) };
    }
    if (this.ts.at("include")) {
      this.ts.error("PAR009", "`include` is not supported");
      this.ts.next();
      if (this.ts.current.kind === "string") this.ts.next();
      this.consumeSemicolon();
      return { kind: "EmptyStatement", span: this.spanFromToken(start) };
    }
    if (this.ts.at("case") || this.ts.at("default")) {
      this.ts.error("PAR010", `'${this.ts.current.text}' is only valid inside a switch`);
      this.ts.next();
      this.ts.match(":");
      return { kind: "EmptyStatement", span: this.spanFromToken(start) };
    }
    if (
      this.ts.current.kind === "word" &&
      this.ts.peek().text === ":" &&
      this.ts.peek(2).text !== "::"
    ) {
      const label = this.ts.next().text;
      this.ts.next();
      const statement = this.parseStatement();
      return {
        kind: "LabeledStatement",
        label,
        statement,
        span: this.spanFromToken(start),
      };
    }

    const expression = this.parseExpression();
    this.consumeSemicolon();
    return {
      kind: "ExpressionStatement",
      expression,
      span: this.spanFromToken(start),
    };
  }

  private parseBlock(): BlockStatement {
    const start = this.ts.current;
    this.ts.expect("{");
    const body: Statement[] = [];
    while (!this.ts.eof() && !this.ts.at("}")) {
      const before = this.ts.pos;
      body.push(this.parseStatement());
      if (this.ts.pos === before) this.ts.next();
    }
    this.ts.expect("}");
    return { kind: "BlockStatement", body, span: this.spanFromToken(start) };
  }

  private parseVariableStatement(): VariableStatement {
    const start = this.ts.current;
    const isConst = this.ts.next().text === "const";
    const declarations: VariableDeclaration[] = [];
    do {
      declarations.push(this.parseVariableDeclaration());
    } while (this.ts.match(","));
    this.consumeSemicolon();
    return {
      kind: "VariableStatement",
      isConst,
      declarations,
      span: this.spanFromToken(start),
    };
  }

  private parseVariableDeclaration(): VariableDeclaration {
    const start = this.ts.current;
    const name = this.ts.expectWord("Expected a variable name");
    const type = this.ts.match(":") ? this.parseType() : null;
    const initializer = this.ts.match("=") ? this.parseAssignment() : null;
    return {
      kind: "VariableDeclaration",
      name,
      type,
      initializer,
      span: this.spanFromToken(start),
    };
  }

  private parseIf(): IfStatement {
    const start = this.ts.current;
    this.ts.expect("if");
    this.ts.expect("(");
    const test = this.parseExpression();
    this.ts.expect(")");
    const consequent = this.parseStatement();
    const alternate = this.ts.match("else") ? this.parseStatement() : null;
    return {
      kind: "IfStatement",
      test,
      consequent,
      alternate,
      span: this.spanFromToken(start),
    };
  }

  private parseWhile(): Statement {
    const start = this.ts.current;
    this.ts.expect("while");
    this.ts.expect("(");
    const test = this.parseExpression();
    this.ts.expect(")");
    const body = this.parseStatement();
    return { kind: "WhileStatement", test, body, span: this.spanFromToken(start) };
  }

  private parseDoWhile(): Statement {
    const start = this.ts.current;
    this.ts.expect("do");
    const body = this.parseStatement();
    this.ts.expect("while");
    this.ts.expect("(");
    const test = this.parseExpression();
    this.ts.expect(")");
    this.consumeSemicolon();
    return { kind: "DoWhileStatement", body, test, span: this.spanFromToken(start) };
  }

  private parseFor(): Statement {
    const start = this.ts.current;
    this.ts.expect("for");
    const each = this.ts.match("each");
    this.ts.expect("(");

    if (each) {
      let declaration: VariableDeclaration | null = null;
      let target: Expression;
      if (this.ts.at("var") || this.ts.at("const")) {
        this.ts.next();
        declaration = this.parseVariableDeclaration();
        target = {
          kind: "Identifier",
          name: declaration.name,
          span: declaration.span,
        };
      } else {
        target = this.parseExpression(true, false);
      }
      this.ts.expect("in");
      const iterable = this.parseExpression();
      this.ts.expect(")");
      const body = this.parseStatement();
      return {
        kind: "ForInStatement",
        each: true,
        declaration,
        target,
        iterable,
        body,
        span: this.spanFromToken(start),
      };
    }

    let init: VariableDeclaration[] | Expression | null = null;
    if (this.ts.at(";")) {
      this.ts.next();
    } else if (this.ts.at("var") || this.ts.at("const")) {
      this.ts.next();
      const declarations: VariableDeclaration[] = [];
      do {
        declarations.push(this.parseVariableDeclaration());
      } while (this.ts.match(","));
      if (this.ts.at("in")) {
        this.ts.next();
        const iterable = this.parseExpression();
        this.ts.expect(")");
        const body = this.parseStatement();
        const declaration = declarations[0] ?? null;
        const target: Expression = declaration
          ? { kind: "Identifier", name: declaration.name, span: declaration.span }
          : { kind: "Identifier", name: "<missing>", span: this.spanFromToken(start) };
        return {
          kind: "ForInStatement",
          each: false,
          declaration,
          target,
          iterable,
          body,
          span: this.spanFromToken(start),
        };
      }
      init = declarations;
      this.ts.expect(";");
    } else {
      const expression = this.parseExpression(true, false);
      if (this.ts.at("in")) {
        this.ts.next();
        const iterable = this.parseExpression();
        this.ts.expect(")");
        const body = this.parseStatement();
        return {
          kind: "ForInStatement",
          each: false,
          declaration: null,
          target: expression,
          iterable,
          body,
          span: this.spanFromToken(start),
        };
      }
      init = expression;
      this.ts.expect(";");
    }

    const test = this.ts.at(";") ? null : this.parseExpression();
    this.ts.expect(";");
    const update = this.ts.at(")") ? null : this.parseExpression();
    this.ts.expect(")");
    const body = this.parseStatement();
    return { kind: "ForStatement", init, test, update, body, span: this.spanFromToken(start) };
  }

  private parseSwitch(): SwitchStatement {
    const start = this.ts.current;
    this.ts.expect("switch");
    this.ts.expect("(");
    const discriminant = this.parseExpression();
    this.ts.expect(")");
    this.ts.expect("{");
    const cases: SwitchCase[] = [];
    while (!this.ts.eof() && !this.ts.at("}")) {
      const caseStart = this.ts.current;
      let test: Expression | null = null;
      if (this.ts.match("case")) {
        test = this.parseExpression();
        this.ts.expect(":");
      } else if (this.ts.match("default")) {
        this.ts.expect(":");
      } else {
        this.ts.error("PAR011", "Expected 'case' or 'default' in switch");
        this.ts.next();
        continue;
      }
      const statements: Statement[] = [];
      while (
        !this.ts.eof() &&
        !this.ts.at("case") &&
        !this.ts.at("default") &&
        !this.ts.at("}")
      ) {
        const before = this.ts.pos;
        statements.push(this.parseStatement());
        if (this.ts.pos === before) this.ts.next();
      }
      cases.push({
        kind: "SwitchCase",
        test,
        statements,
        span: this.spanFromToken(caseStart),
      });
    }
    this.ts.expect("}");
    return {
      kind: "SwitchStatement",
      discriminant,
      cases,
      span: this.spanFromToken(start),
    };
  }

  private parseTry(): TryStatement {
    const start = this.ts.current;
    this.ts.expect("try");
    const block = this.parseBlock();
    const catches: TryStatement["catches"] = [];
    while (this.ts.match("catch")) {
      const catchStart = this.ts.current;
      this.ts.expect("(");
      const name = this.ts.expectWord("Expected a catch parameter name");
      const type = this.ts.match(":") ? this.parseType() : null;
      this.ts.expect(")");
      const catchBlock = this.parseBlock();
      catches.push({
        kind: "CatchClause",
        name,
        type,
        block: catchBlock,
        span: this.spanFromToken(catchStart),
      });
    }
    const finalizer = this.ts.match("finally") ? this.parseBlock() : null;
    return {
      kind: "TryStatement",
      block,
      catches,
      finalizer,
      span: this.spanFromToken(start),
    };
  }

  private parseThrow(): Statement {
    const start = this.ts.current;
    this.ts.expect("throw");
    const expression = this.parseExpression();
    this.consumeSemicolon();
    return { kind: "ThrowStatement", expression, span: this.spanFromToken(start) };
  }

  private parseReturn(): ReturnStatement {
    const start = this.ts.current;
    this.ts.expect("return");
    let expression: Expression | null = null;
    if (!this.ts.at(";") && !this.ts.at("}") && !this.ts.eof() && !this.ts.current.leadingNewline) {
      expression = this.parseExpression();
    }
    this.consumeSemicolon();
    return { kind: "ReturnStatement", expression, span: this.spanFromToken(start) };
  }

  private parseBreak(): Statement {
    const start = this.ts.current;
    this.ts.expect("break");
    const label =
      this.ts.current.kind === "word" && !this.ts.current.leadingNewline
        ? this.ts.next().text
        : null;
    this.consumeSemicolon();
    return { kind: "BreakStatement", label, span: this.spanFromToken(start) };
  }

  private parseContinue(): Statement {
    const start = this.ts.current;
    this.ts.expect("continue");
    const label =
      this.ts.current.kind === "word" && !this.ts.current.leadingNewline
        ? this.ts.next().text
        : null;
    this.consumeSemicolon();
    return { kind: "ContinueStatement", label, span: this.spanFromToken(start) };
  }

  private parseFunctionDeclarationStatement(): FunctionDeclarationStatement {
    const start = this.ts.current;
    const declaration = this.parseMethod([], [], "", null);
    return {
      kind: "FunctionDeclarationStatement",
      declaration,
      span: this.spanFromToken(start),
    };
  }

  /* --------------------------------------------------------------------- */
  /* Expressions                                                           */
  /* --------------------------------------------------------------------- */

  private parseExpression(allowComma = true, allowIn = true): Expression {
    const first = this.parseAssignment(allowIn);
    if (!allowComma) return first;
    const expressions: Expression[] = [first];
    while (this.ts.match(",")) expressions.push(this.parseAssignment(allowIn));
    if (expressions.length === 1) return first;
    const last = expressions[expressions.length - 1]!;
    const node: SequenceExpression = {
      kind: "SequenceExpression",
      expressions,
      span: this.joinSpan(first.span, last.span.end),
    };
    return node;
  }

  private parseAssignment(allowIn = true): Expression {
    const left = this.parseConditional(allowIn);
    if (ASSIGNMENT_OPERATORS.has(this.ts.current.text)) {
      const operator = this.ts.next().text;
      const right = this.parseAssignment(allowIn);
      return {
        kind: "AssignmentExpression",
        operator,
        left,
        right,
        span: this.joinSpan(left.span, right.span.end),
      };
    }
    return left;
  }

  private parseConditional(allowIn: boolean): Expression {
    const test = this.parseBinary(0, allowIn);
    if (!this.ts.match("?")) return test;
    const consequent = this.parseAssignment(allowIn);
    this.ts.expect(":");
    const alternate = this.parseAssignment(allowIn);
    return {
      kind: "ConditionalExpression",
      test,
      consequent,
      alternate,
      span: this.joinSpan(test.span, alternate.span.end),
    };
  }

  private parseBinary(minPrecedence: number, allowIn: boolean): Expression {
    let left = this.parseUnary(allowIn);
    while (true) {
      const operator = this.ts.current.text;
      const precedence = PRECEDENCE[operator];
      if (precedence === undefined || precedence < minPrecedence) break;
      if (operator === "in" && !allowIn) break;
      this.ts.next();

      if (operator === "as" || operator === "is") {
        const type = this.parseType();
        left = {
          kind: "TypeTestExpression",
          operator,
          expression: left,
          type,
          span: this.joinSpan(left.span, this.ts.previous().end),
        };
        continue;
      }

      const right = this.parseBinary(precedence + 1, allowIn);
      left = {
        kind: "BinaryExpression",
        operator,
        left,
        right,
        span: this.joinSpan(left.span, right.span.end),
      };
    }
    return left;
  }

  private parseUnary(allowIn: boolean): Expression {
    const start = this.ts.current;
    const operator = this.ts.current.text;
    if (
      operator === "delete" ||
      operator === "void" ||
      operator === "typeof" ||
      operator === "!" ||
      operator === "~" ||
      operator === "+" ||
      operator === "-" ||
      operator === "++" ||
      operator === "--"
    ) {
      this.ts.next();
      const operand = this.parseUnary(allowIn);
      const node: UnaryExpression = {
        kind: "UnaryExpression",
        operator,
        operand,
        prefix: true,
        span: this.spanFromToken(start),
      };
      return node;
    }
    return this.parsePostfix(allowIn);
  }

  private parsePostfix(allowIn: boolean): Expression {
    let expression = this.parseLeftHandSide(allowIn);
    while (this.ts.at("++") || this.ts.at("--")) {
      const operator = this.ts.next().text;
      expression = {
        kind: "UnaryExpression",
        operator,
        operand: expression,
        prefix: false,
        span: this.joinSpan(expression.span, this.ts.previous().end),
      };
    }
    return expression;
  }

  private parseLeftHandSide(allowIn: boolean): Expression {
    let expression = this.ts.at("new") ? this.parseNew(allowIn) : this.parsePrimary();

    while (true) {
      // `Vector.<T>(value)` is a coercion/cast expression.
      if (
        expression.kind === "Identifier" &&
        expression.name === "Vector" &&
        this.ts.at(".") &&
        this.ts.peek().text === "<"
      ) {
        this.ts.next();
        this.ts.next();
        const element = this.parseType();
        this.expectTypeGreater();
        expression = {
          kind: "VectorTypeExpression",
          element,
          span: this.joinSpan(expression.span, this.ts.previous().end),
        };
        continue;
      }

      // Postfix update can be followed by member access: `x++.toString()`.
      if (this.ts.at("++") || this.ts.at("--")) {
        const operator = this.ts.next().text;
        expression = {
          kind: "UnaryExpression",
          operator,
          operand: expression,
          prefix: false,
          span: this.joinSpan(expression.span, this.ts.previous().end),
        };
        continue;
      }

      if (this.ts.at("(")) {
        const args = this.parseArguments();
        expression = {
          kind: "CallExpression",
          callee: expression,
          args,
          span: this.joinSpan(expression.span, this.ts.previous().end),
        };
        continue;
      }

      if (this.ts.at("[")) {
        this.ts.next();
        const property = this.parseExpression();
        this.ts.expect("]");
        expression = {
          kind: "MemberExpression",
          object: expression,
          property,
          computed: true,
          access: "dot",
          namespace: null,
          span: this.joinSpan(expression.span, this.ts.previous().end),
        };
        continue;
      }

      if (this.ts.at(".") && this.ts.peek().text === "(") {
        this.ts.next();
        this.ts.next();
        const predicate = this.parseExpression();
        this.ts.expect(")");
        expression = {
          kind: "XmlFilterExpression",
          object: expression,
          predicate,
          span: this.joinSpan(expression.span, this.ts.previous().end),
        };
        continue;
      }

      if (this.ts.at(".")) {
        this.ts.next();
        if (this.ts.at("@")) {
          this.ts.next();
          const attribute = this.parseAttributeAccessor();
          expression = this.member(expression, attribute.property, "attribute", attribute.computed);
          continue;
        }
        if (this.ts.at("*")) {
          this.ts.next();
          expression = this.member(expression, "*", "wildcard");
          continue;
        }
        const property = this.parsePropertyName();
        expression = this.member(expression, property, "dot");
        continue;
      }

      if (this.ts.at("::")) {
        this.ts.next();
        const name = this.ts.expectWord("Expected a qualified name");
        if (expression.kind === "MemberExpression" && expression.access === "dot") {
          expression = {
            ...expression,
            access: "qualified",
            namespace: typeof expression.property === "string" ? expression.property : null,
            property: name,
            span: this.joinSpan(expression.span, this.ts.previous().end),
          };
        } else if (expression.kind === "Identifier") {
          const node: QualifiedNameExpression = {
            kind: "QualifiedNameExpression",
            namespace: expression.name,
            name,
            span: this.joinSpan(expression.span, this.ts.previous().end),
          };
          expression = node;
        } else {
          expression = {
            kind: "MemberExpression",
            object: expression,
            property: name,
            computed: false,
            access: "qualified",
            namespace: null,
            span: this.joinSpan(expression.span, this.ts.previous().end),
          };
        }
        continue;
      }

      if (this.ts.at("..")) {
        this.ts.next();
        if (this.ts.at("@")) {
          this.ts.next();
          const attribute = this.parseAttributeAccessor();
          expression = this.member(expression, attribute.property, "descendant", attribute.computed);
          continue;
        }
        if (this.ts.at("*")) {
          this.ts.next();
          expression = this.member(expression, "*", "descendant");
          continue;
        }
        const property = this.parsePropertyName();
        expression = this.member(expression, property, "descendant");
        continue;
      }

      break;
    }

    return expression;
  }

  private member(
    object: Expression,
    property: string | Expression,
    access: MemberAccess,
    computed = false,
  ): MemberExpression {
    return {
      kind: "MemberExpression",
      object,
      property,
      computed,
      access,
      namespace: null,
      span: this.joinSpan(object.span, this.ts.previous().end),
    };
  }

  private parseAttributeAccessor(): { property: string | Expression; computed: boolean } {
    if (this.ts.at("*")) {
      this.ts.next();
      return { property: "*", computed: false };
    }
    if (this.ts.at("[")) {
      this.ts.next();
      const property = this.parseExpression();
      this.ts.expect("]");
      return { property, computed: true };
    }
    return { property: this.parsePropertyName(), computed: false };
  }

  private parseNew(allowIn: boolean): Expression {
    const start = this.ts.current;
    this.ts.expect("new");
    let target: Expression;

    if (this.ts.at("<")) {
      this.ts.next();
      const elementType = this.parseType();
      this.expectTypeGreater();
      const elements = this.parseArrayElements();
      return {
        kind: "TypedArrayExpression",
        elementType,
        elements,
        span: this.spanFromToken(start),
      };
    }

    if (this.ts.at("(")) {
      target = this.parsePrimary();
    } else if (
      this.ts.at("Vector") &&
      this.ts.peek().text === "." &&
      this.ts.peek(2).text === "<"
    ) {
      target = this.parseVectorTypeExpression();
    } else if (this.ts.current.kind === "word") {
      target = this.parsePrimary();
      while (this.ts.at(".")) {
        this.ts.next();
        const property = this.parsePropertyName();
        target = this.member(target, property, "dot");
      }
      if (this.ts.at("::")) {
        this.ts.next();
        const name = this.ts.expectWord("Expected a qualified name");
        target = {
          ...this.member(target, name, "qualified"),
          namespace: target.kind === "Identifier" ? target.name : null,
        };
      }
    } else {
      this.ts.error("PAR012", "Expected a constructor target after 'new'");
      target = this.parsePrimary();
    }

    const args = this.ts.at("(") ? this.parseArguments() : [];
    void allowIn;
    return {
      kind: "NewExpression",
      target,
      args,
      span: this.spanFromToken(start),
    };
  }

  private parseArguments(): Expression[] {
    const args: Expression[] = [];
    this.ts.expect("(");
    if (!this.ts.at(")")) {
      do {
        args.push(this.parseAssignment());
      } while (this.ts.match(","));
    }
    this.ts.expect(")");
    return args;
  }

  private parsePrimary(): Expression {
    const token = this.ts.current;

    if (token.kind === "word") {
      if (token.text === "this") {
        this.ts.next();
        return { kind: "ThisExpression", span: this.spanFromToken(token) };
      }
      if (token.text === "super") {
        this.ts.next();
        return { kind: "SuperExpression", span: this.spanFromToken(token) };
      }
      if (token.text === "function") return this.parseFunctionExpression();
      if (token.text === "true" || token.text === "false") {
        this.ts.next();
        return {
          kind: "Literal",
          literalKind: "boolean",
          raw: token.text,
          value: token.text === "true",
          span: this.spanFromToken(token),
        };
      }
      if (token.text === "null") {
        this.ts.next();
        return {
          kind: "Literal",
          literalKind: "null",
          raw: token.text,
          value: null,
          span: this.spanFromToken(token),
        };
      }
      if (token.text === "undefined") {
        this.ts.next();
        return {
          kind: "Literal",
          literalKind: "undefined",
          raw: token.text,
          value: null,
          span: this.spanFromToken(token),
        };
      }
      this.ts.next();
      const node: Identifier = {
        kind: "Identifier",
        name: token.text,
        span: this.spanFromToken(token),
      };
      return node;
    }

    if (token.kind === "number") {
      this.ts.next();
      return {
        kind: "Literal",
        literalKind: "number",
        raw: token.text,
        value: Number(token.text),
        span: this.spanFromToken(token),
      };
    }

    if (token.kind === "string") {
      this.ts.next();
      return {
        kind: "Literal",
        literalKind: "string",
        raw: token.text,
        value: decodeString(token.text),
        span: this.spanFromToken(token),
      };
    }

    if (token.kind === "regex") {
      this.ts.next();
      return {
        kind: "Literal",
        literalKind: "regex",
        raw: token.text,
        value: token.text,
        span: this.spanFromToken(token),
      };
    }

    if (token.kind === "xml") {
      this.ts.next();
      return {
        kind: "Literal",
        literalKind: "xml",
        raw: token.text,
        value: token.text,
        span: this.spanFromToken(token),
      };
    }

    if (token.text === "[") return this.parseArrayLiteral();
    if (token.text === "{") return this.parseObjectLiteral();
    if (token.text === "(") {
      this.ts.next();
      const expression = this.parseExpression();
      this.ts.expect(")");
      const node: ParenthesizedExpression = {
        kind: "ParenthesizedExpression",
        expression,
        span: this.spanFromToken(token),
      };
      return node;
    }
    if (token.text === "@") {
      this.ts.next();
      const name = this.ts.at("*") ? this.ts.next().text : this.parsePropertyName();
      const node: AttributeSelectorExpression = {
        kind: "AttributeSelectorExpression",
        name,
        span: this.spanFromToken(token),
      };
      return node;
    }

    this.ts.error("PAR013", `Expected an expression but found '${this.ts.describe()}'`);
    if (!this.ts.eof()) this.ts.next();
    return {
      kind: "Identifier",
      name: "<error>",
      span: this.spanFromToken(token),
    };
  }

  private parseFunctionExpression(): FunctionExpression {
    const start = this.ts.current;
    this.ts.expect("function");
    let name: string | null = null;
    if (this.ts.current.kind === "word" && this.ts.peek().text === "(") {
      name = this.ts.next().text;
    }
    const params = this.parseParameters();
    const returnType = this.ts.match(":") ? this.parseType() : null;
    const body = this.parseBlock();
    return {
      kind: "FunctionExpression",
      name,
      params,
      returnType,
      body,
      span: this.spanFromToken(start),
    };
  }

  private parseArrayLiteral(): ArrayLiteral {
    const start = this.ts.current;
    const elements = this.parseArrayElements();
    return { kind: "ArrayLiteral", elements, span: this.spanFromToken(start) };
  }

  private parseArrayElements(): (Expression | null)[] {
    this.ts.expect("[");
    const elements: (Expression | null)[] = [];
    while (!this.ts.eof() && !this.ts.at("]")) {
      if (this.ts.at(",")) {
        this.ts.next();
        elements.push(null);
        continue;
      }
      elements.push(this.parseAssignment());
      if (!this.ts.match(",")) break;
    }
    this.ts.expect("]");
    return elements;
  }

  private parseObjectLiteral(): ObjectLiteral {
    const start = this.ts.current;
    this.ts.expect("{");
    const properties: ObjectLiteral["properties"] = [];
    while (!this.ts.eof() && !this.ts.at("}")) {
      const propertyStart = this.ts.current;
      let key: string;
      if (this.ts.current.kind === "word") {
        key = this.ts.next().text;
      } else if (this.ts.current.kind === "string") {
        // A quoted key names the property without its quotes: `{"type": 1}` is `type`.
        key = decodeString(this.ts.next().text);
      } else if (this.ts.current.kind === "number") {
        key = this.ts.next().text;
      } else {
        this.ts.error("PAR014", "Expected an object property name");
        this.ts.next();
        continue;
      }
      this.ts.expect(":");
      const value = this.parseAssignment();
      properties.push({
        kind: "ObjectProperty",
        key,
        value,
        span: this.spanFromToken(propertyStart),
      });
      if (!this.ts.match(",")) break;
    }
    this.ts.expect("}");
    return { kind: "ObjectLiteral", properties, span: this.spanFromToken(start) };
  }

  /* --------------------------------------------------------------------- */
  /* Types and helpers                                                     */
  /* --------------------------------------------------------------------- */

  private parseType(): TypeNode {
    const start = this.ts.current;
    if (this.ts.match("*")) {
      return { kind: "WildcardType", span: this.spanFromToken(start) };
    }
    if (this.ts.splitLeading("*")) {
      return {
        kind: "WildcardType",
        span: span(this.ts.file, start.start, start.start + 1, start.line, start.column),
      };
    }
    if (
      this.ts.at("Vector") &&
      this.ts.peek().text === "." &&
      this.ts.peek(2).text === "<"
    ) {
      this.ts.next();
      this.ts.next();
      this.ts.next();
      const element = this.parseType();
      this.expectTypeGreater();
      return {
        kind: "VectorType",
        element,
        span: this.spanFromToken(start),
      };
    }

    let name = this.ts.expectWord("Expected a type name");
    let namespace: string | null = null;
    if (this.ts.match("::")) {
      namespace = name;
      name = this.ts.expectWord("Expected a qualified type name");
    } else {
      while (this.ts.match(".")) {
        name += `.${this.ts.expectWord("Expected a type name")}`;
      }
    }
    return {
      kind: "NamedType",
      name,
      namespace,
      span: this.spanFromToken(start),
    };
  }

  private parseVectorTypeExpression(): VectorTypeExpression {
    const start = this.ts.current;
    this.ts.expect("Vector");
    this.ts.expect(".");
    this.ts.expect("<");
    const element = this.parseType();
    this.expectTypeGreater();
    return { kind: "VectorTypeExpression", element, span: this.spanFromToken(start) };
  }

  private expectTypeGreater(): void {
    if (this.ts.match(">")) return;
    if (this.ts.splitGreater()) return;
    this.ts.error("PAR015", "Expected '>' to close a type argument list");
  }

  private parseParameters(): Parameter[] {
    const params: Parameter[] = [];
    this.ts.expect("(");
    if (!this.ts.at(")")) {
      do {
        const start = this.ts.current;
        const rest = this.ts.match("...");
        const name = this.ts.expectWord("Expected a parameter name");
        const type = this.ts.match(":") ? this.parseType() : null;
        const defaultValue = this.ts.match("=") ? this.parseAssignment() : null;
        params.push({
          kind: "Parameter",
          name,
          type,
          defaultValue,
          rest,
          span: this.spanFromToken(start),
        });
      } while (this.ts.match(","));
    }
    this.ts.expect(")");
    return params;
  }

  private parseQualifiedName(): string {
    let name = this.ts.expectWord("Expected a qualified name");
    while (this.ts.match(".")) {
      name += `.${this.ts.expectWord("Expected a name after '.'")}`;
    }
    return name;
  }

  private parseQualifiedNameWithWildcard(): { name: string; wildcard: boolean } {
    let name = this.ts.expectWord("Expected an import name");
    while (this.ts.match(".")) {
      if (this.ts.at("*")) {
        this.ts.next();
        return { name, wildcard: true };
      }
      name += `.${this.ts.expectWord("Expected a name after '.'")}`;
    }
    return { name, wildcard: false };
  }

  private parsePropertyName(): string {
    if (this.ts.current.kind === "word") return this.ts.next().text;
    if (this.ts.current.kind === "string") return this.ts.next().text.slice(1, -1);
    this.ts.error("PAR016", "Expected a property name");
    return "<missing>";
  }

  private parseStringValue(): string {
    if (this.ts.current.kind === "string") return decodeString(this.ts.next().text);
    this.ts.error("PAR017", "Expected a string literal");
    if (!this.ts.eof()) this.ts.next();
    return "";
  }

  private parseModifiers(): Modifier[] {
    const modifiers: Modifier[] = [];
    while (this.ts.current.kind === "word" && MODIFIERS.has(this.ts.current.text)) {
      modifiers.push(this.ts.next().text as Modifier);
    }
    return modifiers;
  }

  private consumeSemicolon(): void {
    if (this.ts.match(";")) return;
    if (this.ts.at("}") || this.ts.eof()) return;
    // The decompiled corpus contains omitted semicolons at line boundaries.
    // Treat a newline as a statement terminator rather than rejecting the file.
    if (this.ts.current.leadingNewline) return;
    this.ts.error("PAR018", "Expected ';'");
  }

  private skipToSemicolon(): void {
    while (!this.ts.eof() && !this.ts.at(";") && !this.ts.at("}")) this.ts.next();
    this.ts.match(";");
  }

  private skipTopLevelElement(): void {
    while (!this.ts.eof() && !this.ts.at("}")) {
      if (this.ts.at("{")) {
        this.skipBalanced("{", "}");
        return;
      }
      if (this.ts.match(";")) return;
      this.ts.next();
    }
  }

  private skipMember(): void {
    while (!this.ts.eof() && !this.ts.at("}")) {
      if (this.ts.at("{")) {
        this.skipBalanced("{", "}");
        return;
      }
      if (this.ts.match(";")) return;
      this.ts.next();
    }
  }

  private skipBalanced(open: string, close: string): void {
    if (!this.ts.at(open)) return;
    let depth = 0;
    while (!this.ts.eof()) {
      if (this.ts.at(open)) depth++;
      else if (this.ts.at(close)) {
        depth--;
        if (depth === 0) {
          this.ts.next();
          return;
        }
      }
      this.ts.next();
    }
  }

  private spanFromToken(start: Token): Span {
    const end = this.ts.previous();
    return span(this.ts.file, start.start, end.end, start.line, start.column);
  }

  private joinSpan(start: Span, end: number): Span {
    return span(this.ts.file, start.start, end, start.line, start.column);
  }

  private emptyClass(start: Token): ClassDeclaration {
    return {
      kind: "ClassDeclaration",
      name: "<error>",
      modifiers: [],
      metadata: [],
      extends: null,
      implements: [],
      members: [],
      span: this.spanFromToken(start),
    };
  }
}

function decodeString(raw: string): string {
  if (raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  return body.replace(
    /\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|r|t|b|f|v|0|\\|'|")/g,
    (_match, escape: string) => {
      if (escape === "n") return "\n";
      if (escape === "r") return "\r";
      if (escape === "t") return "\t";
      if (escape === "b") return "\b";
      if (escape === "f") return "\f";
      if (escape === "v") return "\v";
      if (escape === "0") return "\0";
      if (escape === "\\") return "\\";
      if (escape === "'") return "'";
      if (escape === '"') return '"';
      if (escape.startsWith("u")) return String.fromCharCode(parseInt(escape.slice(1), 16));
      if (escape.startsWith("x")) return String.fromCharCode(parseInt(escape.slice(1), 16));
      return escape;
    },
  );
}

/* Intentionally exported so callers can use the inferred statement types. */
export type ParsedFor = ForStatement;
export type ParsedForIn = ForInStatement;
export type ParsedIf = IfStatement;
export type ParsedLabeled = LabeledStatement;
export type ParsedMethod = MethodDeclaration;
export type ParsedSwitch = SwitchStatement;
export type ParsedImport = ImportDeclaration;
