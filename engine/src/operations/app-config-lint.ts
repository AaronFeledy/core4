import { dirname } from "node:path";
import { loadLandofileLayers } from "@lando/landofile/service";
import { Effect, Either } from "effect";
import { landofileRuntimeInputs } from "../composition.ts";
import { compileEffectiveTooling } from "../planner/effective-tooling.ts";
import { unknownEventError, unknownEventName, validEventNames } from "../planner/event-names.ts";

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
> =>
  Effect.gen(function* () {
    const result = yield* lintLandofile(options);
    if (!result.valid) return result;
    const loaded = yield* loadLandofileLayers(dirname(result.file), result.file, {
      ...landofileRuntimeInputs(),
      ...(options.templates === undefined ? {} : { templates: options.templates }),
    }).pipe(Effect.either);
    if (Either.isLeft(loaded)) {
      return { ...result, valid: false, violations: [{ path: "", message: loaded.left.message }] };
    }
    // Provider-free lint uses fully layered/included tooling; the planner adds resolved service contributions.
    const valid = validEventNames(compileEffectiveTooling({ landofile: loaded.right, services: [] }));
    const unknown = unknownEventName(loaded.right.events, valid);
    if (unknown !== undefined) return yield* Effect.fail(unknownEventError(unknown, valid, result.file));
    return result;
  });
