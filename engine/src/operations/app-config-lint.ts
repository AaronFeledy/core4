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

import { type LintLandofileOptions, routeViolations } from "@lando/landofile/lint";
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
  const landofile = snapshot.resolved;
  const pluginRegistry = yield* PluginRegistry;
  const configService = Option.getOrUndefined(yield* Effect.serviceOption(ConfigService));
  const fileSystem = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem));
  const pathsService = Option.getOrUndefined(yield* Effect.serviceOption(PathsService));
  const resolved = yield* resolveKnownEventSet({
    landofile,
    pluginRegistry,
    configService,
    fileSystem,
    pathsService,
    file: result.file,
  }).pipe(Effect.result);
  if (Result.isFailure(resolved)) {
    if (resolved.failure._tag === "ConfigExpressionError") {
      const path = configExpressionIssuePath(resolved.failure);
      const source = getLandofileValueSource(landofile, path);
      return {
        ...result,
        valid: false,
        violations: [
          ...result.violations,
          {
            rule: "landofile.expression",
            severity: "error",
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
  const key = (violation: { readonly path: ReadonlyArray<string | number>; readonly message: string }) =>
    JSON.stringify([violation.path, violation.message]);
  const reported = new Set(result.violations.map(key));
  const evaluated = routeViolations(resolved.success.landofile, { deferExpressions: false })
    .filter((violation) => !reported.has(key(violation)))
    .map((violation) => {
      const source = getLandofileValueSource(landofile, violation.path);
      return { ...violation, scope: "effective" as const, ...(source === undefined ? {} : { source }) };
    });
  return evaluated.length === 0
    ? result
    : { ...result, valid: false, violations: [...result.violations, ...evaluated] };
});
