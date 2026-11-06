import type { TemplateValidationError } from "@actions/workflow-parser/templates/template-validation-error";
import { diagnostic, location } from "./diagnostics.ts";
import type { DiagnosticCode, DiagnosticField, WorkflowDiagnostic } from "./schema.ts";
import { type WorkflowSourceIndex, sourceContext } from "./source-context.ts";

export const parserDiagnostic = (
  name: string,
  error: TemplateValidationError,
  index: WorkflowSourceIndex,
): WorkflowDiagnostic => {
  const context = sourceContext(index, error.range?.start);
  let { path } = context;
  let code: DiagnosticCode = "workflow-invalid";
  let rule: NonNullable<WorkflowDiagnostic["rule"]> = "syntax";
  // Only exact upstream templates or fixed prefixes select classifications; no authored captures survive.
  const required = (["jobs", "runs-on", "steps", "on"] satisfies DiagnosticField[]).find(
    (field) => error.rawMessage === `Required property is missing: ${field}`,
  );
  if (required !== undefined) {
    path = [...sourceContext(index, error.range?.start, true).path, required];
    code = "workflow-required";
    rule = "required";
  } else if (/^'[^\r\n]*' is already defined$/u.test(error.rawMessage)) {
    code = "workflow-duplicate-key";
    rule = "duplicate-key";
  } else if (error.rawMessage.startsWith("Unexpected value '") && context.key) {
    code = "workflow-unknown-key";
    rule = "unknown-key";
  } else if (
    error.rawMessage === "A mapping was not expected" ||
    error.rawMessage === "A sequence was not expected" ||
    error.rawMessage === "Invalid format for steps" ||
    (error.rawMessage.startsWith("Unexpected value '") && path.at(-1) === "steps")
  ) {
    code = "workflow-type";
    rule = "type";
  } else if (error.rawMessage.startsWith("Unexpected value '")) rule = "value";
  else if (
    error.rawMessage === "A template expression is not allowed in this context" ||
    error.rawMessage.startsWith("The expression is not closed.")
  )
    rule = "expression";
  const result = diagnostic(code, location(name, error.range?.start));
  const field = path.at(-1);
  return {
    ...result,
    path,
    ...(field === undefined ? {} : { field }),
    rule,
    ...(required === undefined
      ? {}
      : {
          remediation: `Add the required ${required} property at the indicated mapping using GitHub Actions workflow syntax.`,
        }),
  };
};
