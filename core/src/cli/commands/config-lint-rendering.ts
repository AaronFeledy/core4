import { dirname, relative, sep } from "node:path";
import { type ConfigLintViolation, formatValidationIssuePath } from "@lando/sdk/schema";
import { escapeDiagnosticText } from "../diagnostic-text";

const formatPath = (path: ConfigLintViolation["path"]): string => {
  const formatted = formatValidationIssuePath(path);
  return formatted.length === 0 ? "(root)" : escapeDiagnosticText(formatted);
};

const renderViolation = (violation: ConfigLintViolation, landofilePath?: string): string => {
  const where =
    violation.source?.layer === "script"
      ? escapeDiagnosticText(
          landofilePath === undefined
            ? violation.source.file
            : // Same POSIX form as script help; the "at" line keeps the native absolute path.
              relative(dirname(landofilePath), violation.source.file)
                .split(sep)
                .join("/"),
        )
      : formatPath(violation.path);
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
    const authoredText =
      authored === where || (source.layer === "script" && source.path.length === 0)
        ? ""
        : `, authored as ${authored}`;
    const details = scopeText.length === 0 ? `${source.layer} layer` : `${source.layer} layer; ${scopeText}`;
    const sourceFile = "file" in source ? source.file : undefined;
    if (sourceFile !== undefined)
      lines.push(`    at ${escapeDiagnosticText(sourceFile)}${line}${column}${authoredText} (${details})`);
  } else if (scopeText.length > 0) {
    lines.push(`    scopes: ${scopeText}`);
  }
  if (violation.suggestion !== undefined) {
    for (const [index, line] of violation.suggestion.split("\n").entries()) {
      lines.push(`${index === 0 ? "    fix: " : "       | "}${escapeDiagnosticText(line)}`);
    }
  }
  return lines.join("\n");
};

export const renderConfigLintViolations = (
  violations: ReadonlyArray<ConfigLintViolation>,
  landofilePath?: string,
): ReadonlyArray<string> => violations.map((violation) => renderViolation(violation, landofilePath));
