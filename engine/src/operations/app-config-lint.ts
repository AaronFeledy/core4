import { getLandofileValueSource } from "@lando/landofile/validation";
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
import { lintLandofileSnapshot } from "../services/landofile-live.ts";

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
  const snapshot = yield* lintLandofileSnapshot(options);
  const { result } = snapshot;
  if (snapshot.resolved === undefined) return result;
  const pluginRegistry = yield* PluginRegistry;
  const configService = Option.getOrUndefined(yield* Effect.serviceOption(ConfigService));
  const fileSystem = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem));
  const pathsService = Option.getOrUndefined(yield* Effect.serviceOption(PathsService));
  const resolved = yield* resolveKnownEventSet({
    landofile: snapshot.resolved,
    pluginRegistry,
    configService,
    fileSystem,
    pathsService,
    file: result.file,
  }).pipe(Effect.result);
  if (Result.isFailure(resolved)) {
    if (resolved.failure._tag === "ConfigExpressionError") {
      const path = configExpressionIssuePath(resolved.failure);
      const source = getLandofileValueSource(snapshot.resolved, path);
      return {
        ...result,
        valid: false,
        violations: [
          ...result.violations,
          {
            path,
            message: resolved.failure.message,
            scope: "effective" as const,
            ...(source === undefined ? {} : { source }),
          },
        ],
      };
    }
    return yield* Effect.fail(resolved.failure);
  }
  return result;
});
