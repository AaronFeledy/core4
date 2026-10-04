import { type ConfigLintViolation, formatValidationIssuePath } from "@lando/sdk/schema";
import { escapeDiagnosticText } from "../diagnostic-text";

export const renderConfigLintViolation = (violation: ConfigLintViolation): string => {
  const formatted = formatValidationIssuePath(violation.path);
  const where = formatted.length === 0 ? "(root)" : escapeDiagnosticText(formatted);
  const lines = [`  ${where}: ${escapeDiagnosticText(violation.message)}`];
  if (violation.suggestion !== undefined) {
    lines.push(`    fix: ${escapeDiagnosticText(violation.suggestion)}`);
  }
  return lines.join("\n");
};
