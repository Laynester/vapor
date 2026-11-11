import { diag, span, type Diagnostic } from "../diagnostics.ts";
import type { Token, TokenKind } from "./token.ts";

const MULTI_PUNCT = [
  ">>>=",
  "===",
  "!==",
  ">>>",
  "<<=",
  ">>=",
  "...",
  "::",
  "..",
  "==",
  "!=",
  "<=",
  ">=",
  "||=",
  "&&=",
  "&&",
  "||",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
];

const EXPRESSION_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "delete",
  "typeof",
  "void",
  "in",
  "of",
  "as",
  "is",
  "new",
]);

function isIdentifierStart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "_" ||
    ch === "$"
  );
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || (ch >= "0" && ch <= "9");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isXmlNameStart(ch: string): boolean {
  return isIdentifierStart(ch) || ch === ":";
}

function isXmlNamePart(ch: string): boolean {
  return isIdentifierPart(ch) || ch === ":" || ch === "-" || ch === ".";
}

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
}

export class Lexer {
  private readonly source: string;
  private readonly file: string;
  private i = 0;
  private line = 1;
  private lineStart = 0;
  private sawNewline = false;
  private tokens: Token[] = [];
  private diagnostics: Diagnostic[] = [];
  private previous: Token | null = null;

  constructor(source: string, file = "<input>") {
    this.source = source;
    this.file = file;
  }

  tokenize(): LexResult {
    while (true) {
      this.skipTrivia();
      if (this.i >= this.source.length) {
        this.tokens.push({
          kind: "eof",
          text: "",
          start: this.i,
          end: this.i,
          line: this.line,
          column: this.i - this.lineStart + 1,
          leadingNewline: this.sawNewline,
        });
        break;
      }

      const start = this.i;
      const startLine = this.line;
      const startColumn = this.i - this.lineStart + 1;
      const leadingNewline = this.sawNewline;
      this.sawNewline = false;
      const ch = this.source[this.i];

      if (ch === '"' || ch === "'") {
        const end = this.scanString(start, ch);
        this.emit("string", start, end, leadingNewline, startLine, startColumn);
        continue;
      }

      if (isDigit(ch) || (ch === "." && isDigit(this.source[this.i + 1] ?? ""))) {
        const end = this.scanNumber(start);
        this.emit("number", start, end, leadingNewline, startLine, startColumn);
        continue;
      }

      if (isIdentifierStart(ch)) {
        let end = start + 1;
        while (end < this.source.length && isIdentifierPart(this.source[end])) end++;
        this.emit("word", start, end, leadingNewline, startLine, startColumn);
        continue;
      }

      if (ch === "<" && this.isXmlStart()) {
        const xmlEnd = this.scanXmlLiteral(start);
        if (xmlEnd !== null) {
          this.emit("xml", start, xmlEnd, leadingNewline, startLine, startColumn);
          continue;
        }
      }

      if (ch === "/" && this.isRegexStart()) {
        const regexEnd = this.scanRegex(start);
        if (regexEnd !== null) {
          this.emit("regex", start, regexEnd, leadingNewline, startLine, startColumn);
          continue;
        }
      }

      let punctEnd = start + 1;
      for (const p of MULTI_PUNCT) {
        if (this.source.startsWith(p, start)) {
          punctEnd = start + p.length;
          break;
        }
      }
      this.emit("punct", start, punctEnd, leadingNewline, startLine, startColumn);
    }

    return { tokens: this.tokens, diagnostics: this.diagnostics };
  }

  /* --------------------------------------------------------------------- */
  /* Trivia and position helpers                                           */
  /* --------------------------------------------------------------------- */

  private skipTrivia(): void {
    const src = this.source;
    while (this.i < src.length) {
      const ch = src[this.i];
      if (ch === "\n") {
        this.i++;
        this.line++;
        this.lineStart = this.i;
        this.sawNewline = true;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v" || ch === "\ufeff") {
        this.i++;
        continue;
      }
      if (ch === "/" && src[this.i + 1] === "/") {
        let end = src.indexOf("\n", this.i + 2);
        if (end < 0) end = src.length;
        this.advancePosition(this.i, end);
        this.i = end;
        continue;
      }
      if (ch === "/" && src[this.i + 1] === "*") {
        let end = src.indexOf("*/", this.i + 2);
        if (end < 0) {
          const startLine = this.line;
          const startColumn = this.i - this.lineStart + 1;
          this.diagnostics.push(
            diag(
              "error",
              "LEX001",
              "Unterminated block comment",
              span(this.file, this.i, src.length, startLine, startColumn),
            ),
          );
          this.advancePosition(this.i, src.length);
          this.i = src.length;
          return;
        }
        end += 2;
        this.advancePosition(this.i, end);
        this.i = end;
        continue;
      }
      break;
    }
  }

  private advancePosition(start: number, end: number): void {
    const text = this.source.slice(start, end);
    let idx = -1;
    let count = 0;
    while ((idx = text.indexOf("\n", idx + 1)) >= 0) count++;
    if (count > 0) {
      this.line += count;
      const last = text.lastIndexOf("\n");
      this.lineStart = start + last + 1;
      this.sawNewline = true;
    }
  }

  private emit(
    kind: TokenKind,
    start: number,
    end: number,
    leadingNewline: boolean,
    line: number,
    column: number,
  ): void {
    const token: Token = {
      kind,
      text: this.source.slice(start, end),
      start,
      end,
      line,
      column,
      leadingNewline,
    };
    this.tokens.push(token);
    this.previous = token;
    this.advancePosition(start, end);
    this.i = end;
  }

  /* --------------------------------------------------------------------- */
  /* Strings, numbers, regex                                               */
  /* --------------------------------------------------------------------- */

  private scanString(start: number, quote: string): number {
    const src = this.source;
    let i = start + 1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) return i + 1;
      if (ch === "\n") {
        this.diagnostics.push(
          diag(
            "error",
            "LEX002",
            "Unterminated string literal",
            span(this.file, start, i, this.line, this.columnAt(start)),
          ),
        );
        return i;
      }
      i++;
    }
    this.diagnostics.push(
      diag(
        "error",
        "LEX002",
        "Unterminated string literal",
        span(this.file, start, src.length, this.line, this.columnAt(start)),
      ),
    );
    return src.length;
  }

  private scanNumber(start: number): number {
    const src = this.source;
    let i = start;
    if (src[i] === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
      i += 2;
      const digitsStart = i;
      while (i < src.length && isHexDigit(src[i])) i++;
      if (i === digitsStart) {
        this.diagnostics.push(
          diag(
            "error",
            "LEX003",
            "Hexadecimal literal requires at least one digit",
            span(this.file, start, i, this.line, this.columnAt(start)),
          ),
        );
      }
      return i;
    }

    if (src[i] === ".") {
      i++;
      while (i < src.length && isDigit(src[i])) i++;
    } else {
      while (i < src.length && isDigit(src[i])) i++;
      if (src[i] === ".") {
        i++;
        while (i < src.length && isDigit(src[i])) i++;
      }
    }

    if (src[i] === "e" || src[i] === "E") {
      const exponentStart = i;
      i++;
      if (src[i] === "+" || src[i] === "-") i++;
      const digitsStart = i;
      while (i < src.length && isDigit(src[i])) i++;
      if (i === digitsStart) {
        this.diagnostics.push(
          diag(
            "error",
            "LEX004",
            "Malformed numeric exponent",
            span(this.file, exponentStart, i, this.line, this.columnAt(exponentStart)),
          ),
        );
      }
    }
    return i;
  }

  private isRegexStart(): boolean {
    if (this.source[this.i + 1] === "/" || this.source[this.i + 1] === "*") return false;
    const prev = this.previous;
    if (!prev) return true;
    if (prev.kind === "number" || prev.kind === "string" || prev.kind === "regex" || prev.kind === "xml") {
      return false;
    }
    if (prev.kind === "word") {
      return EXPRESSION_KEYWORDS.has(prev.text);
    }
    if (prev.kind === "punct") {
      return !(
        prev.text === ")" ||
        prev.text === "]" ||
        prev.text === "}" ||
        prev.text === "++" ||
        prev.text === "--"
      );
    }
    return true;
  }

  private scanRegex(start: number): number | null {
    const src = this.source;
    let i = start + 1;
    let inClass = false;
    let escaped = false;
    while (i < src.length) {
      const ch = src[i];
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        i++;
        continue;
      }
      if (ch === "[") {
        inClass = true;
        i++;
        continue;
      }
      if (ch === "]") {
        inClass = false;
        i++;
        continue;
      }
      if (ch === "/" && !inClass) {
        i++;
        while (i < src.length && isIdentifierPart(src[i])) i++;
        return i;
      }
      if (ch === "\n") return null;
      i++;
    }
    return null;
  }

  /* --------------------------------------------------------------------- */
  /* XML literals                                                          */
  /* --------------------------------------------------------------------- */

  private isXmlStart(): boolean {
    const next = this.source[this.i + 1] ?? "";
    if (!(isXmlNameStart(next) || next === "!" || next === "?")) return false;
    const prev = this.previous;
    if (!prev) return true;
    if (prev.kind === "number" || prev.kind === "string" || prev.kind === "regex" || prev.kind === "xml") {
      return false;
    }
    if (prev.kind === "word") {
      // `new <T>[...]` is a typed array literal, not XML.
      if (prev.text === "new") return false;
      return EXPRESSION_KEYWORDS.has(prev.text);
    }
    if (prev.kind === "punct") {
      // `Vector.<T>` is a type argument list, not an XML literal.
      if (prev.text === ".") {
        const beforeDot = this.tokens[this.tokens.length - 2];
        if (beforeDot?.text === "Vector") return false;
      }
      return !(
        prev.text === ")" ||
        prev.text === "]" ||
        prev.text === "}" ||
        prev.text === "++" ||
        prev.text === "--"
      );
    }
    return true;
  }

  /** Returns the end offset of a complete XML literal, or null if this is not one. */
  private scanXmlLiteral(start: number): number | null {
    const src = this.source;
    let i = start;
    const stack: string[] = [];
    let sawRoot = false;

    while (i < src.length) {
      if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i + 4);
        if (end < 0) return this.unterminatedXml(start);
        i = end + 3;
        continue;
      }
      if (src.startsWith("<![CDATA[", i)) {
        const end = src.indexOf("]]>", i + 9);
        if (end < 0) return this.unterminatedXml(start);
        i = end + 3;
        continue;
      }
      if (src.startsWith("<?", i)) {
        const end = src.indexOf("?>", i + 2);
        if (end < 0) return this.unterminatedXml(start);
        i = end + 2;
        continue;
      }
      if (src.startsWith("<!", i)) {
        let j = i + 2;
        let quote: string | null = null;
        while (j < src.length) {
          const c = src[j];
          if (quote) {
            if (c === quote) quote = null;
          } else if (c === '"' || c === "'") {
            quote = c;
          } else if (c === ">") {
            j++;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }

      if (src[i] !== "<") {
        while (i < src.length && src[i] !== "<") {
          if (src[i] === "{") {
            i = this.skipBalancedBraces(i);
            if (i < 0) return this.unterminatedXml(start);
          } else {
            i++;
          }
        }
        continue;
      }

      if (src[i + 1] === "/") {
        const nameStart = i + 2;
        let j = nameStart;
        while (j < src.length && isXmlNamePart(src[j])) j++;
        const name = src.slice(nameStart, j);
        while (j < src.length && src[j] !== ">") j++;
        if (j >= src.length) return this.unterminatedXml(start);
        i = j + 1;
        if (stack.length > 0) {
          const expected = stack[stack.length - 1];
          const match = stack.lastIndexOf(name);
          if (match < 0) {
            this.diagnostics.push(
              diag(
                "warning",
                "LEX005",
                `Unexpected XML closing tag </${name}>`,
                span(this.file, i, i, this.line, this.columnAt(i)),
              ),
            );
          } else {
            if (match !== stack.length - 1) {
              this.diagnostics.push(
                diag(
                  "warning",
                  "LEX005",
                  `XML closing tag </${name}> closes <${expected}> before it is closed`,
                  span(this.file, i, i, this.line, this.columnAt(i)),
                ),
              );
            }
            stack.length = match;
          }
        }
        if (sawRoot && stack.length === 0) return i;
        continue;
      }

      const nameStart = i + 1;
      let j = nameStart;
      while (j < src.length && isXmlNamePart(src[j])) j++;
      if (j === nameStart) return null;
      const name = src.slice(nameStart, j);
      let selfClosing = false;
      let quote: string | null = null;
      while (j < src.length) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = null;
          j++;
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          j++;
          continue;
        }
        if (c === "{") {
          j = this.skipBalancedBraces(j);
          if (j < 0) return this.unterminatedXml(start);
          continue;
        }
        if (c === "/" && src[j + 1] === ">") {
          selfClosing = true;
          j += 2;
          break;
        }
        if (c === ">") {
          j++;
          break;
        }
        j++;
      }
      if (j >= src.length && !selfClosing) return this.unterminatedXml(start);
      i = j;
      sawRoot = true;
      if (selfClosing) {
        if (stack.length === 0) return i;
      } else {
        stack.push(name);
      }
    }

    return this.unterminatedXml(start);
  }

  private unterminatedXml(start: number): number {
    this.diagnostics.push(
      diag(
        "error",
        "LEX006",
        "Unterminated XML literal",
        span(this.file, start, this.source.length, this.line, this.columnAt(start)),
      ),
    );
    return this.source.length;
  }

  private skipBalancedBraces(start: number): number {
    const src = this.source;
    let i = start + 1;
    let depth = 1;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'") {
        const quote = c;
        i++;
        while (i < src.length) {
          if (src[i] === "\\") {
            i += 2;
            continue;
          }
          if (src[i] === quote) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return -1;
  }

  private columnAt(index: number): number {
    return index - this.lineStart + 1;
  }
}
