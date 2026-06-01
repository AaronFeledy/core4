import type { Effect } from "effect";

import type { LandofileNotFoundError } from "@lando/sdk/errors";
import type { ConfigLintResult } from "@lando/sdk/schema";

import { type LintLandofileOptions, lintLandofile } from "../../landofile/lint.ts";
import { renderConfigLintViolation } from "./config-lint-rendering.ts";

export type AppConfigLintFormat = "text" | "json";

export type AppConfigLintOptions = LintLandofileOptions;

/**
 * Canonical-schema-only lint of the current app's Landofile. Thin wrapper over
 * the shared `lintLandofile` pass so `app:config:lint` and `doctor --app` never
 * fork the validation logic.
 */
export const appConfigLint = (
  options: AppConfigLintOptions = {},
): Effect.Effect<ConfigLintResult, LandofileNotFoundError, never> => lintLandofile(options);

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
 * command exits non-zero (side-effect render pattern, identical across the
 * OCLIF and compiled dispatch paths — mirrors `renderExecAppResult`).
 */
export const renderConfigLintResult = (
  result: ConfigLintResult,
  format: AppConfigLintFormat = "text",
): string => {
  if (!result.valid) process.exitCode = 1;
  return format === "json" ? JSON.stringify(result, null, 2) : textRender(result);
};
