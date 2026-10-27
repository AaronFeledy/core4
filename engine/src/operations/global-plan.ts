import { Effect } from "effect";

import { type AppPlacementError, GlobalAppError, type LandofileParseError } from "@lando/sdk/errors";
import type { AppPlan, LoadScopedLandofile } from "@lando/sdk/schema";
import {
  AppPlanner,
  type AppPlannerError,
  FileSystem,
  type FileSystemError,
  type GlobalAppPaths,
  GlobalAppService,
  type ProviderSelectionError,
  RuntimeProviderRegistry,
  type StateStore,
} from "@lando/sdk/services";

import type { LandofileFinalizeOverrides } from "@lando/landofile/service";

import { globalCreateProviderId, resolveGlobalPlacement } from "../global-app/placement.ts";
import { hostProviderId } from "../providers/host-provider.ts";
import { loadLandofileLayers } from "../services/landofile-live.ts";

export interface MissingGlobalPlanResult {
  readonly materialized: false;
  readonly paths: GlobalAppPaths;
}

export interface LoadedGlobalPlanResult {
  readonly materialized: true;
  readonly paths: GlobalAppPaths;
  readonly landofile: LoadScopedLandofile;
  readonly plan: AppPlan;
}

export type LoadGlobalPlanResult = MissingGlobalPlanResult | LoadedGlobalPlanResult;

export type LoadGlobalPlanError =
  | AppPlacementError
  | AppPlannerError
  | Effect.Error<ReturnType<typeof loadLandofileLayers>>
  | ProviderSelectionError
  | FileSystemError
  | GlobalAppError
  | LandofileParseError;

export type LoadGlobalPlanServices =
  | AppPlanner
  | FileSystem
  | GlobalAppService
  | RuntimeProviderRegistry
  | StateStore;

export const globalLandofileOverrides = Effect.map(
  hostProviderId,
  (provider): LandofileFinalizeOverrides => ({ name: "global", provider }),
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
          remediation: `Ensure the global app directory at ${cwd} exists and is accessible, then retry.`,
        }),
    }),
    () => use(),
    (original) => Effect.sync(() => process.chdir(original)),
  );

export const readGlobalLandofile = Effect.fn("GlobalApp.readLandofile")(function* (): Effect.fn.Return<
  MissingGlobalPlanResult | Omit<LoadedGlobalPlanResult, "plan">,
  GlobalAppError | FileSystemError | Effect.Error<ReturnType<typeof loadLandofileLayers>>,
  FileSystem | GlobalAppService | StateStore
> {
  const globalApp = yield* GlobalAppService;
  const fileSystem = yield* FileSystem;
  const paths = yield* globalApp.paths;
  const exists = yield* fileSystem.exists(paths.distLandofile);
  if (!exists) return { materialized: false, paths };

  const landofile = yield* loadLandofileLayers(
    paths.root,
    paths.userLandofile,
    yield* globalLandofileOverrides,
  );
  return { materialized: true, paths, landofile };
});

export const loadGlobalPlan = Effect.fnUntraced(function* (): Effect.fn.Return<
  LoadGlobalPlanResult,
  LoadGlobalPlanError,
  LoadGlobalPlanServices
> {
  yield* globalCreateProviderId();
  const loaded = yield* readGlobalLandofile();
  if (!loaded.materialized) return loaded;
  const { paths, landofile } = loaded;
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(landofile.document.provider);
  const planner = yield* AppPlanner;
  const plan = yield* withProcessCwd(paths.root, () => planner.plan(landofile, provider.capabilities));

  return { materialized: true, paths, landofile, plan };
});

export const loadObservedGlobalPlan = Effect.fn("GlobalApp.loadObservedPlan")(function* () {
  const globalApp = yield* GlobalAppService;
  const paths = yield* globalApp.paths;
  const { plan } = yield* resolveGlobalPlacement();
  if (plan !== undefined) return { materialized: true as const, paths, plan };
  return yield* loadGlobalPlan();
});

export type LoadObservedGlobalPlanError = Effect.Error<ReturnType<typeof loadObservedGlobalPlan>>;
