/** `lando app:config:lint` rendering. The operation lives in `core/src/operations/app-config-lint.ts`. */
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

/**
 * Render a lint result. Sets `process.exitCode = 1` on any violation so the
 * command exits non-zero (side-effect render pattern, identical for source and
 * compiled entries of the native dispatcher — mirrors `renderExecAppResult`).
 */
export const renderConfigLintResult = (
  result: ConfigLintResult,
  _format: AppConfigLintFormat = "text",
): string => {
  if (!result.valid) process.exitCode = 1;
  return textRender(result);
};
