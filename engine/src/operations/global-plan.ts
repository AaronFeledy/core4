import { Effect } from "effect";

import { GlobalAppError, type LandofileParseError } from "@lando/sdk/errors";
import type { AppPlan, LandofileShape } from "@lando/sdk/schema";
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

import { landofileLayerPaths } from "@lando/landofile/layers";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "@lando/landofile/load-expression-file";
import { type LandofileCompileError, loadLandofileContentLayers } from "@lando/landofile/root-compile";

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
  | LandofileCompileError
  | ProviderSelectionError
  | FileSystemError
  | GlobalAppError
  | LandofileParseError;

export type LoadGlobalPlanServices = AppPlanner | FileSystem | GlobalAppService | RuntimeProviderRegistry;

export const decodeGlobalLandofile = (input: {
  readonly file: string;
  readonly content: string;
  readonly cwd: string;
}): Effect.Effect<LandofileShape, LandofileCompileError> =>
  loadLandofileContentLayers(
    [
      {
        filePath: input.file,
        content: input.content,
        layer: "canonical",
        order: 3,
        basename: ".lando",
      },
    ],
    {
      appRoot: input.cwd,
      policy: DEFAULT_LANDOFILE_LOAD_POLICY,
    },
    { file: input.file },
  );

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

export const readGlobalLandofile = Effect.fn("GlobalApp.readLandofile")(function* (): Effect.fn.Return<
  MissingGlobalPlanResult | Omit<LoadedGlobalPlanResult, "plan">,
  GlobalAppError | FileSystemError | LandofileCompileError,
  FileSystem | GlobalAppService
> {
  const globalApp = yield* GlobalAppService;
  const fileSystem = yield* FileSystem;
  const paths = yield* globalApp.paths;
  const exists = yield* fileSystem.exists(paths.distLandofile);
  if (!exists) return { materialized: false, paths };

  const rawLayers = [];
  for (const position of landofileLayerPaths(paths.root)) {
    const file = position.yamlPath;
    if (!(yield* fileSystem.exists(file))) continue;
    const content = yield* fileSystem.readText(file);
    rawLayers.push({ ...position, filePath: file, content });
  }
  const landofile = yield* loadLandofileContentLayers(
    rawLayers,
    {
      appRoot: paths.root,
      policy: DEFAULT_LANDOFILE_LOAD_POLICY,
    },
    { file: paths.userLandofile, forced: { name: "global", provider: MANAGED_PROVIDER_ID } },
  );
  return { materialized: true, paths, landofile };
});

export const loadGlobalPlan = Effect.fnUntraced(function* (): Effect.fn.Return<
  LoadGlobalPlanResult,
  LoadGlobalPlanError,
  LoadGlobalPlanServices
> {
  const loaded = yield* readGlobalLandofile();
  if (!loaded.materialized) return loaded;
  const { paths, landofile } = loaded;
  const registry = yield* RuntimeProviderRegistry;
  const managed = yield* registry.select(MANAGED_PROVIDER_SELECT_PLAN);
  const planner = yield* AppPlanner;
  const plan = yield* withProcessCwd(paths.root, () => planner.plan(landofile, managed.capabilities));

  return { materialized: true, paths, landofile, plan };
});
