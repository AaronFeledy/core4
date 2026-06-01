import { Effect, ParseResult } from "effect";

import {
  type CapabilityError,
  GlobalAppError,
  type LandofileParseError,
  LandofileValidationError,
  type NoProviderInstalledError,
  type NotImplementedError,
  type ProviderConfigError,
  type ProviderUnavailableError,
} from "@lando/sdk/errors";
import { type AppPlan, type LandofileShape, LandofileShape as LandofileShapeSchema } from "@lando/sdk/schema";
import {
  AppPlanner,
  FileSystem,
  type FileSystemError,
  type GlobalAppPaths,
  GlobalAppService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { parseLandofile } from "../../../landofile/parser.ts";
import { decodeOrFail } from "../../../schema/decode.ts";

export interface MissingGlobalPlanResult {
  readonly materialized: false;
  readonly paths: GlobalAppPaths;
}

export interface LoadedGlobalPlanResult {
  readonly materialized: true;
  readonly paths: GlobalAppPaths;
  readonly landofile: LandofileShape;
  readonly plan: AppPlan;
}

export type LoadGlobalPlanResult = MissingGlobalPlanResult | LoadedGlobalPlanResult;

export type LoadGlobalPlanError =
  | CapabilityError
  | FileSystemError
  | GlobalAppError
  | LandofileParseError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderUnavailableError;

export type LoadGlobalPlanServices = AppPlanner | FileSystem | GlobalAppService | RuntimeProviderRegistry;

const validationIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : issue.path.join("."),
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid Landofile."];
};

const validateGlobalLandofile = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<LandofileShape, LandofileValidationError> =>
  decodeOrFail(LandofileShapeSchema, (cause) => {
    const issues = validationIssues(cause);
    return new LandofileValidationError({
      message: `Landofile contains unsupported MVP keys: ${issues.join(", ")}. Remove unsupported keys or update the documented Landofile service schema.`,
      file: filePath,
      issues,
    });
  })(parsed, { onExcessProperty: "error" });

export const decodeGlobalLandofile = (input: {
  readonly file: string;
  readonly content: string;
  readonly cwd: string;
}): Effect.Effect<LandofileShape, LandofileParseError | LandofileValidationError> =>
  parseLandofile(input).pipe(Effect.flatMap((parsed) => validateGlobalLandofile(input.file, parsed)));

const withProcessCwd = <A, E, R>(
  cwd: string,
  use: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | GlobalAppError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const original = process.cwd();
        process.chdir(cwd);
        return original;
      },
      catch: (cause) =>
        new GlobalAppError({
          message: `Unable to enter the global app directory at ${cwd}.`,
          operation: "loadPlan",
          cause,
        }),
    }),
    () => use(),
    (original) => Effect.sync(() => process.chdir(original)),
  );

export const loadGlobalPlan = (): Effect.Effect<
  LoadGlobalPlanResult,
  LoadGlobalPlanError,
  LoadGlobalPlanServices
> =>
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const fileSystem = yield* FileSystem;
    const paths = yield* globalApp.paths;
    const exists = yield* fileSystem.exists(paths.distLandofile);
    if (!exists) return { materialized: false, paths };

    const content = yield* fileSystem.readText(paths.distLandofile);
    const landofile = yield* decodeGlobalLandofile({
      file: paths.distLandofile,
      content,
      cwd: paths.root,
    });
    const registry = yield* RuntimeProviderRegistry;
    const capabilities = yield* registry.capabilities;
    const planner = yield* AppPlanner;
    const plan = yield* withProcessCwd(paths.root, () => planner.plan(landofile, capabilities));

    return { materialized: true, paths, landofile, plan };
  });
