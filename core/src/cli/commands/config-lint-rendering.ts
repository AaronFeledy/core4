import { type ConfigLintViolation, formatValidationIssuePath } from "@lando/sdk/schema";
import { escapeDiagnosticText } from "../diagnostic-text";

const formatPath = (path: ConfigLintViolation["path"]): string => {
  const formatted = formatValidationIssuePath(path);
  return formatted.length === 0 ? "(root)" : escapeDiagnosticText(formatted);
};

const renderViolation = (violation: ConfigLintViolation): string => {
  const where = formatPath(violation.path);
  const lines = [
    `  ${where}: ${violation.severity} [${escapeDiagnosticText(violation.rule)}] ${escapeDiagnosticText(violation.message)}`,
  ];
  const scopeText = violation.scopes?.join(" and ") ?? "";
  const { source } = violation;
  if (source !== undefined) {
    const line = violation.line === undefined ? "" : `:${violation.line}`;
    const column =
      violation.line === undefined || violation.column === undefined ? "" : `:${violation.column}`;
    const authored = formatPath(source.path);
    const authoredText = authored === where ? "" : `, authored as ${authored}`;
    const details = scopeText.length === 0 ? `${source.layer} layer` : `${source.layer} layer; ${scopeText}`;
    const sourceFile = "file" in source ? source.file : undefined;
    if (sourceFile !== undefined)
      lines.push(`    at ${escapeDiagnosticText(sourceFile)}${line}${column}${authoredText} (${details})`);
  } else if (scopeText.length > 0) {
    lines.push(`    scopes: ${scopeText}`);
  }
  if (violation.suggestion !== undefined) {
    lines.push(`    fix: ${escapeDiagnosticText(violation.suggestion)}`);
  }
  return lines.join("\n");
};

export const renderConfigLintViolations = (
  violations: ReadonlyArray<ConfigLintViolation>,
): ReadonlyArray<string> => violations.map(renderViolation);
