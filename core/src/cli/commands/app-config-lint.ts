/** `lando app:config:lint` result rendering. */
import type { ConfigLintResult } from "@lando/sdk/schema";

import { renderConfigLintViolation } from "./config-lint-rendering";

export type AppConfigLintFormat = "text" | "json";

export const renderConfigLintResult = (
  result: ConfigLintResult,
  _format: AppConfigLintFormat = "text",
): string => {
  if (result.violations.length === 0) {
    return `${result.file}: no config lint findings.`;
  }
  const header = `${result.file}: ${result.violations.length} config lint finding${
    result.violations.length === 1 ? "" : "s"
  }.`;
  const lines = result.violations.map(renderConfigLintViolation);
  return [header, ...lines].join("\n");
};
