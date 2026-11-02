/** `lando app:config:lint` result rendering. */
import type { ConfigLintResult } from "@lando/sdk/schema";

import { renderConfigLintViolations } from "./config-lint-rendering";

export type AppConfigLintFormat = "text" | "json";

export const renderConfigLintResult = (
  result: ConfigLintResult,
  _format: AppConfigLintFormat = "text",
): string => {
  if (result.violations.length === 0) {
    return `${result.file}: no config lint findings.`;
  }
  const findings = renderConfigLintViolations(result.violations);
  const header = `${result.file}: ${findings.length} config lint finding${findings.length === 1 ? "" : "s"}.`;
  return [header, ...findings].join("\n");
};
