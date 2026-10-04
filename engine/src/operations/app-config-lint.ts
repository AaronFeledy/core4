import { dirname } from "node:path";
import { loadLandofileLayers } from "@lando/landofile/service";
import { ConfigService, FileSystem, PathsService, PluginRegistry } from "@lando/sdk/services";
import { Effect, Option, Result } from "effect";
import { resolveKnownEventSet } from "../planner/event-set.ts";
import { configExpressionIssuePath } from "../planner/landofile-scopes.ts";

import type {
  CommandAliasConflictError,
  LandofileFormConflictError,
  LandofileNotFoundError,
  LandofileUnknownEventError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import type { ConfigLintResult } from "@lando/sdk/schema";

import type { LintLandofileOptions } from "@lando/landofile/lint";
import { lintLandofile, scopedLandofileRuntimeInputs } from "../services/landofile-live.ts";

export type AppConfigLintOptions = LintLandofileOptions;

/**
 * Schema and resolved event-name validation shared by config lint and doctor.
 */
export const appConfigLint = Effect.fn("AppOperation.configLint")(function* (
  options: AppConfigLintOptions = {},
): Effect.fn.Return<
  ConfigLintResult,
  | LandofileNotFoundError
  | LandofileFormConflictError
  | LandofileUnknownEventError
  | LandofileValidationError
  | CommandAliasConflictError
  | NotImplementedError,
  PluginRegistry
> {
  const result = yield* lintLandofile(options);
  if (!result.valid) return result;
  const runtimeInputs = yield* scopedLandofileRuntimeInputs;
  const loaded = yield* loadLandofileLayers(dirname(result.file), result.file, {
    ...runtimeInputs,
    ...(options.templates === undefined ? {} : { templates: options.templates }),
  }).pipe(Effect.result);
  if (Result.isFailure(loaded)) {
    return { ...result, valid: false, violations: [{ path: [], message: loaded.failure.message }] };
  }
  const pluginRegistry = yield* PluginRegistry;
  const configService = Option.getOrUndefined(yield* Effect.serviceOption(ConfigService));
  const fileSystem = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem));
  const pathsService = Option.getOrUndefined(yield* Effect.serviceOption(PathsService));
  const resolved = yield* resolveKnownEventSet({
    landofile: loaded.success,
    pluginRegistry,
    configService,
    fileSystem,
    pathsService,
    file: result.file,
  }).pipe(Effect.result);
  if (Result.isFailure(resolved)) {
    if (resolved.failure._tag === "ConfigExpressionError") {
      return {
        ...result,
        valid: false,
        violations: [
          { path: configExpressionIssuePath(resolved.failure), message: resolved.failure.message },
        ],
      };
    }
    return yield* Effect.fail(resolved.failure);
  }
  return result;
});
