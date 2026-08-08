import type { ConfigLintViolation } from "@lando/sdk/schema";
import { escapeDiagnosticText } from "../diagnostic-text";

export const renderConfigLintViolation = (violation: ConfigLintViolation): string => {
  const where = violation.path.length === 0 ? "(root)" : escapeDiagnosticText(violation.path);
  const lines = [`  ${where}: ${escapeDiagnosticText(violation.message)}`];
  if (violation.suggestedFix !== undefined) {
    lines.push(`    fix: ${escapeDiagnosticText(violation.suggestedFix)}`);
  }
  return lines.join("\n");
};
