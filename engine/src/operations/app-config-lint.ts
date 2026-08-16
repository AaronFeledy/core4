import type { Effect } from "effect";

import type {
  LandofileFormConflictError,
  LandofileNotFoundError,
  LandofileUnknownEventError,
} from "@lando/sdk/errors";
import type { ConfigLintResult } from "@lando/sdk/schema";

import type { LintLandofileOptions } from "@lando/landofile/lint";
import { lintLandofile } from "../services/landofile-live.ts";

export type AppConfigLintOptions = LintLandofileOptions;

/**
 * Canonical-schema-only lint of the current app's Landofile. Thin wrapper over
 * the shared `lintLandofile` pass so `app:config:lint` and `doctor --app` never
 * fork the validation logic.
 */
export const appConfigLint = (
  options: AppConfigLintOptions = {},
): Effect.Effect<
  ConfigLintResult,
  LandofileNotFoundError | LandofileFormConflictError | LandofileUnknownEventError,
  never
> => lintLandofile(options);
