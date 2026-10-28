import { Schema } from "effect";
import { safeText } from "../diagnostics.ts";

export const LanguageSourceSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.optionalKey(Schema.Number),
  column: Schema.optionalKey(Schema.Number),
});
export type LanguageSource = typeof LanguageSourceSchema.Type;
export const sourceNameLimit = 4096;
export const languageSource = (source: LanguageSource): LanguageSource => ({
  file: safeText(
    source.file.length > sourceNameLimit
      ? `${source.file.slice(0, sourceNameLimit)} [source name truncated]`
      : source.file,
  ),
  ...(Number.isSafeInteger(source.line) && (source.line ?? 0) > 0 ? { line: source.line } : {}),
  ...(Number.isSafeInteger(source.column) && (source.column ?? 0) > 0 ? { column: source.column } : {}),
});
const codes = [
  "source-limit",
  "file-limit",
  "yaml-syntax",
  "yaml-alias",
  "yaml-depth",
  "yaml-nodes",
  "yaml-alias-unresolved",
  "yaml-alias-cycle",
  "yaml-expansion-limit",
  "workflow-invalid",
  "workflow-duplicate-key",
  "action-invalid",
  "parser-failure",
  "expression-syntax",
  "expression-evaluation",
  "expression-limit",
  "context-unavailable",
  "template-key",
] as const;
export class LanguageError extends Schema.TaggedError<LanguageError>()("LanguageError", {
  message: Schema.Literal("GitHub Actions language input could not be processed."),
  code: Schema.Literals(codes),
  source: LanguageSourceSchema,
  remediation: Schema.String,
}) {}
export const languageError = (code: (typeof codes)[number], source: LanguageSource): LanguageError =>
  new LanguageError({
    message: "GitHub Actions language input could not be processed.",
    code,
    source: languageSource(source),
    remediation:
      code === "context-unavailable"
        ? "Supply this context at its permitted evaluation phase, or preserve the expression as deferred."
        : code.includes("limit") || code.includes("depth") || code.includes("nodes")
          ? "Reduce the input size, nesting, or expansion to fit the finite language budgets."
          : "Correct the GitHub Actions syntax at the source location using the pinned supported language version.",
  });
// A fixed sentinel permits lazy contexts without embedding unavailable values in diagnostics.
export class UnavailableContext extends Error {
  constructor() {
    super("Context is unavailable at this phase.");
  }
}
export class ExpressionLimit extends Error {}
