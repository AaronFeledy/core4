/** `lando app:config:lint` result rendering. */
import { type ConfigLintResult, formatValidationIssuePath } from "@lando/sdk/schema";

import { renderConfigLintViolations } from "./config-lint-rendering";

export type AppConfigLintFormat = "text" | "json";

export const renderConfigLintResult = (
  result: ConfigLintResult,
  _format: AppConfigLintFormat = "text",
): string => {
  const findings = renderConfigLintViolations(result.violations, result.file);
  const header =
    findings.length === 0
      ? `${result.file}: no config lint findings.`
      : `${result.file}: ${findings.length} config lint finding${findings.length === 1 ? "" : "s"}.`;
  const skips = (result.skipped ?? []).map(
    ({ stage, path, message }) =>
      `  ${stage}${path === undefined ? "" : ` [${formatValidationIssuePath(path)}]`}: ${message}`,
  );
  return [header, ...findings, ...(skips.length === 0 ? [] : ["", "Not checked:", ...skips])].join("\n");
};
