/** A half-open source range, with 1-based line/column at the start. */
export interface Span {
  file: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export type Severity = "error" | "warning";

export type DiagnosticCode =
  | `LEX${number}`
  | `PAR${number}`
  | `SEM${number}`
  | `AST${number}`
  | `IR${number}`
  | `JS${number}`;

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  span: Span;
  notes?: string[];
}

export function span(
  file: string,
  start: number,
  end: number,
  line: number,
  column: number,
): Span {
  return { file, start, end, line, column };
}

export function diag(
  severity: Severity,
  code: string,
  message: string,
  at: Span,
  notes?: string[],
): Diagnostic {
  return notes ? { severity, code, message, span: at, notes } : { severity, code, message, span: at };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = `${d.span.file}:${d.span.line}:${d.span.column}`;
  const notes = d.notes?.length ? `\n${d.notes.map((n) => `  note: ${n}`).join("\n")}` : "";
  return `${where}: ${d.severity} ${d.code}: ${d.message}${notes}`;
}
