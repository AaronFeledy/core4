import { diagnostic, location } from "./diagnostics.ts";
import { LanguageError } from "./language/errors.ts";
import { preflightLanguage } from "./language/preflight.ts";
import type { DiagnosticCode, WorkflowDiagnostic } from "./schema.ts";
import type { WorkflowSourceIndex } from "./source-context.ts";

export const preflight = (
  name: string,
  content: string,
):
  | { readonly status: "accepted"; readonly index: WorkflowSourceIndex }
  | { readonly status: "rejected"; readonly diagnostic: WorkflowDiagnostic } => {
  try {
    return { status: "accepted", index: preflightLanguage(name, content, "inspection").sourceIndex };
  } catch (error) {
    const codes: readonly DiagnosticCode[] = [
      "file-limit",
      "yaml-syntax",
      "yaml-alias",
      "yaml-depth",
      "yaml-nodes",
    ];
    const code =
      error instanceof LanguageError && codes.includes(error.code as DiagnosticCode)
        ? (error.code as DiagnosticCode)
        : "parser-failure";
    const p =
      error instanceof LanguageError && error.source.line !== undefined && error.source.column !== undefined
        ? { line: error.source.line, column: error.source.column }
        : undefined;
    return { status: "rejected", diagnostic: diagnostic(code, location(name, p)) };
  }
};
