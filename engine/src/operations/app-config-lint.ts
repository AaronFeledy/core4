import { dirname, resolve } from "node:path";
import { parseEnvFile } from "@lando/landofile/env-file";
import { loadLandofileLayers } from "@lando/landofile/service";
import { ConfigService, FileSystem, PathsService, PluginRegistry } from "@lando/sdk/services";
import { type Context, Effect, Option, Result } from "effect";
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
import type { ConfigLintResult, ConfigLintViolation, LandofileShape } from "@lando/sdk/schema";

import type { LintLandofileOptions } from "@lando/landofile/lint";
import { lintLandofile, scopedLandofileRuntimeInputs } from "../services/landofile-live.ts";

export type AppConfigLintOptions = LintLandofileOptions;

type EnvFileRef = {
  readonly path: ConfigLintViolation["path"];
  readonly files: ReadonlyArray<string>;
};

const landofileEnvFileRefs = (landofile: typeof LandofileShape.Type): ReadonlyArray<EnvFileRef> => {
  const refs: EnvFileRef[] = [];
  if (landofile.env_file !== undefined && landofile.env_file.length > 0) {
    refs.push({ path: ["env_file"], files: landofile.env_file });
  }
  for (const [name, service] of Object.entries(landofile.services ?? {})) {
    if (service.envFile !== undefined && service.envFile.length > 0) {
      refs.push({ path: ["services", name, "envFile"], files: service.envFile });
    }
  }
  return refs;
};

const lintEnvFiles = Effect.fnUntraced(function* (
  landofile: typeof LandofileShape.Type,
  appRoot: string,
  fileSystem: Context.Service.Shape<typeof FileSystem> | undefined,
): Effect.fn.Return<{
  readonly violations: ReadonlyArray<ConfigLintViolation>;
  readonly warnings: ReadonlyArray<ConfigLintViolation>;
}> {
  const refs = landofileEnvFileRefs(landofile);
  if (refs.length === 0) return { violations: [], warnings: [] };
  if (fileSystem === undefined) {
    return {
      violations: [
        {
          path: refs[0]?.path ?? ["env_file"],
          message:
            "The Landofile declares env_file, but the FileSystem service is unavailable. Provide FileSystem so env files can be read.",
        },
      ],
      warnings: [],
    };
  }

  const violations: ConfigLintViolation[] = [];
  const warnings: ConfigLintViolation[] = [];
  for (const ref of refs) {
    for (const [fileIndex, authoredPath] of ref.files.entries()) {
      const source = resolve(appRoot, authoredPath);
      const path = [...ref.path, fileIndex];
      const content = yield* fileSystem.readText(source).pipe(Effect.result);
      if (Result.isFailure(content)) {
        violations.push({
          path,
          message: `Unable to read env file ${source}: ${content.failure.message}. Create a readable env file at that path or remove it from env_file.`,
        });
        continue;
      }
      const parsed = parseEnvFile(content.success, source);
      if (!parsed.ok) {
        violations.push({
          path,
          message: `Invalid env file entry at ${parsed.issue.source}:${parsed.issue.line}: ${parsed.issue.message}`,
          line: parsed.issue.line,
          ...(parsed.issue.suggestion === undefined ? {} : { suggestion: parsed.issue.suggestion }),
        });
        continue;
      }
      for (const warning of parsed.warnings) {
        warnings.push({
          path,
          message: `${source}:${warning.line}: ${warning.message}`,
          suggestion: warning.suggestion,
          line: warning.line,
        });
      }
    }
  }
  return { violations, warnings };
});

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
  const envLint = yield* lintEnvFiles(loaded.success, dirname(result.file), fileSystem);
  if (envLint.violations.length > 0) {
    return {
      ...result,
      valid: false,
      violations: envLint.violations,
      ...(envLint.warnings.length === 0 ? {} : { warnings: envLint.warnings }),
    };
  }
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
        ...(envLint.warnings.length === 0 ? {} : { warnings: envLint.warnings }),
      };
    }
    return yield* Effect.fail(resolved.failure);
  }
  if (envLint.warnings.length === 0) return result;
  return { ...result, warnings: envLint.warnings };
});
