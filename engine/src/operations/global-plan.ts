import { Effect } from "effect";

import { GlobalAppError, type LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type LandofileShape,
  LandofileShape as LandofileShapeSchema,
  formatValidationIssueLine,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  type AppPlannerError,
  FileSystem,
  type FileSystemError,
  type GlobalAppPaths,
  GlobalAppService,
  type ProviderSelectionError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { decodeOrFail } from "@lando/landofile/decode";
import { parseLandofile } from "@lando/landofile/parser";

import { MANAGED_PROVIDER_ID, MANAGED_PROVIDER_SELECT_PLAN } from "../providers/managed.ts";

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
  | AppPlannerError
  | ProviderSelectionError
  | FileSystemError
  | GlobalAppError
  | LandofileParseError;

export type LoadGlobalPlanServices = AppPlanner | FileSystem | GlobalAppService | RuntimeProviderRegistry;

const validationIssues = (cause: unknown) =>
  validationIssuesFromCause(cause, { fallback: "Invalid Landofile." });

const validateGlobalLandofile = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<LandofileShape, LandofileValidationError> =>
  decodeOrFail(LandofileShapeSchema, (cause) => {
    const issues = validationIssues(cause);
    return new LandofileValidationError({
      message: `Landofile contains unsupported MVP keys: ${issues.map(formatValidationIssueLine).join(", ")}. Remove unsupported keys or update the documented Landofile service schema.`,
      file: filePath,
      issues,
    });
  })(parsed, { onExcessProperty: "error", errors: "all" });

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

export const loadGlobalPlan = Effect.fnUntraced(function* (): Effect.fn.Return<
  LoadGlobalPlanResult,
  LoadGlobalPlanError,
  LoadGlobalPlanServices
> {
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
  const managed = yield* registry.select(MANAGED_PROVIDER_SELECT_PLAN);
  const planner = yield* AppPlanner;
  const landofileForPlan = { ...landofile, provider: MANAGED_PROVIDER_ID };
  const plan = yield* withProcessCwd(paths.root, () => planner.plan(landofileForPlan, managed.capabilities));

  return { materialized: true, paths, landofile: landofileForPlan, plan };
});
