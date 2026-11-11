export type TokenKind =
  | "word"
  | "number"
  | "string"
  | "regex"
  | "xml"
  | "punct"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** Exact source text for the token (strings include their quotes). */
  text: string;
  start: number;
  end: number;
  line: number;
  column: number;
  /** True when at least one newline/comment preceded this token. */
  leadingNewline: boolean;
}
