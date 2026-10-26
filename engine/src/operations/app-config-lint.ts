import { dirname } from "node:path";
import { getLandofileValueSource } from "@lando/landofile/validation";
import { ConfigService, FileSystem, PathsService, PluginRegistry } from "@lando/sdk/services";
import { Effect, Option, Result } from "effect";
import { resolveLandofileForPlanning } from "../planner/event-set.ts";
import { configExpressionIssuePath } from "../planner/landofile-scopes.ts";
import { lintCapabilityIssues } from "../planner/lint-capabilities.ts";
import { toolingAndEventIssues } from "../planner/tooling-event-issues.ts";

import type {
  LandofileFormConflictError,
  LandofileNotFoundError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import type { ConfigLintResult, ValidationIssue } from "@lando/sdk/schema";

import {
  type LintLandofileOptions,
  attributeEffectiveLintIssue,
  mergeLintFindings,
} from "@lando/landofile/lint";
import { lintLandofileSnapshot } from "../services/landofile-live.ts";

export type AppConfigLintOptions = LintLandofileOptions;

const sourceFile = (source: ValidationIssue["source"]): string | undefined =>
  source !== undefined && "file" in source ? source.file : undefined;

/**
 * Config lint shared by `app:config:lint` and doctor: the load snapshot's
 * findings plus the planner's resolved-Landofile validation stage, so lint
 * reports resolve-pass, reserved tooling-name, and fully resolved event-name
 * findings together without building a plan.
 */
export const appConfigLint = Effect.fn("AppOperation.configLint")(function* (
  options: AppConfigLintOptions = {},
): Effect.fn.Return<
  ConfigLintResult,
  LandofileNotFoundError | LandofileFormConflictError | LandofileValidationError | NotImplementedError,
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
  const resolved = yield* resolveLandofileForPlanning({
    landofile,
    pluginRegistry,
    configService,
    fileSystem,
    pathsService,
    ...(pluginRegistry.declaredProviderCapabilities === undefined
      ? {}
      : { resolveCapabilities: pluginRegistry.declaredProviderCapabilities }),
    file: snapshot.landofilePath,
    appRoot: dirname(snapshot.landofilePath),
  }).pipe(Effect.result);
  if (Result.isFailure(resolved)) {
    if (resolved.failure._tag === "ConfigExpressionError") {
      const path = configExpressionIssuePath(resolved.failure);
      const source = getLandofileValueSource(landofile, path);
      return {
        ...result,
        valid: false,
        violations: mergeLintFindings([
          ...result.violations,
          {
            rule: "landofile.expression",
            severity: "error",
            path,
            message: resolved.failure.message,
            scopes: ["effective"],
            ...(source === undefined ? {} : { source }),
          },
        ]),
      };
    }
    return yield* Effect.fail(resolved.failure);
  }
  const issues = [
    ...(resolved.success._tag === "Invalid" ? resolved.success.issues : []),
    ...toolingAndEventIssues(resolved.success.resolution),
    ...(yield* lintCapabilityIssues(resolved.success.resolution)),
  ];
  const evaluated = issues.map((issue) => attributeEffectiveLintIssue(landofile, issue));
  const violations = mergeLintFindings([...result.violations, ...evaluated]);
  return {
    ...result,
    file: sourceFile(result.violations[0]?.source) ?? sourceFile(evaluated[0]?.source) ?? result.file,
    valid: !violations.some((issue) => issue.severity === "error"),
    violations,
  };
});
