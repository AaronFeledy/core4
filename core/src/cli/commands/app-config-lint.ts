/** `lando app:config:lint` result rendering. */
import type { ConfigLintResult } from "@lando/sdk/schema";

import { renderConfigLintViolation } from "./config-lint-rendering";

export type AppConfigLintFormat = "text" | "json";

export const renderConfigLintResult = (
  result: ConfigLintResult,
  _format: AppConfigLintFormat = "text",
): string => {
  if (result.valid) {
    return `${result.file}: no canonical-schema violations.`;
  }
  const header = `${result.file}: ${result.violations.length} canonical-schema violation${
    result.violations.length === 1 ? "" : "s"
  }.`;
  const lines = result.violations.map(renderConfigLintViolation);
  return [header, ...lines].join("\n");
};
