/** `lando app:config:lint` result rendering. */
import type { ConfigLintResult } from "@lando/sdk/schema";

import { renderConfigLintViolation } from "./config-lint-rendering.ts";

export type AppConfigLintFormat = "text" | "json";

const textRender = (result: ConfigLintResult): string => {
  if (result.valid) {
    return `${result.file}: no canonical-schema violations.`;
  }
  const header = `${result.file}: ${result.violations.length} canonical-schema violation${
    result.violations.length === 1 ? "" : "s"
  }.`;
  const lines = result.violations.map(renderConfigLintViolation);
  return [header, ...lines].join("\n");
};

/** Sets a failing process exit code when canonical-schema violations are present. */
export const renderConfigLintResult = (
  result: ConfigLintResult,
  _format: AppConfigLintFormat = "text",
): string => {
  if (!result.valid) process.exitCode = 1;
  return textRender(result);
};
