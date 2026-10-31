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

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { copyLandofileProvenance } from "@lando/landofile/copy-provenance";
import type { LandofileFinalizeOverrides } from "@lando/landofile/service";

import { globalCreateProviderId, resolveGlobalPlacement } from "../global-app/placement.ts";
import {
  type GlobalResolution,
  projectEffectiveGlobalResolution,
  readGlobalResolution,
  withGlobalResolutionCapabilities,
} from "../global-app/resolution.ts";
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
  | LandofileParseError
  | Effect.Error<ReturnType<typeof readGlobalLandofile>>;

export type LoadGlobalPlanServices =
  | AppPlanner
  | FileSystem
  | GlobalAppService
  | RuntimeProviderRegistry
  | StateStore
  | import("@lando/sdk/services").PathsService
  | import("@lando/sdk/services").PluginRegistry;

export const globalLandofileOverrides = Effect.gen(function* () {
  const provider = yield* hostProviderId;
  const resolution = yield* readGlobalResolution({ providerId: provider });
  return {
    name: "global",
    provider,
    excludedServices: resolution.directlyExcludedIds,
  } satisfies LandofileFinalizeOverrides;
});

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

export const readGlobalLandofile = Effect.fn("GlobalApp.readLandofile")(function* (
  options: { readonly resolution?: GlobalResolution; readonly services?: ReadonlyArray<string> } = {},
) {
  const globalApp = yield* GlobalAppService;
  const fileSystem = yield* FileSystem;
  const paths = yield* globalApp.paths;
  const exists = yield* fileSystem.exists(paths.distLandofile);
  if (!exists) return { materialized: false as const, paths };

  const resolution = options.resolution ?? (yield* readGlobalResolution());
  const landofile = yield* loadLandofileLayers(paths.root, paths.userLandofile, {
    name: "global",
    provider: yield* hostProviderId,
    excludedServices: resolution.directlyExcludedIds,
  });
  const effective = projectEffectiveGlobalResolution(
    resolution,
    landofile.document.services ?? {},
    landofile.pendingSites,
  );
  const issue = effective.errors.find(
    (issue) =>
      (issue.kind === "dependency" || issue.kind === "cycle") &&
      (!options.services?.length || options.services.includes(issue.id)),
  );
  if (issue !== undefined) return yield* Effect.fail(issue.cause);
  const excluded = new Set(effective.excludedIds);
  const admitted = rememberLandofileAppRoot(
    copyLandofileProvenance(landofile, {
      ...landofile,
      document: copyLandofileProvenance(landofile.document, {
        ...landofile.document,
        services: effective.services,
      }),
      pendingSites: landofile.pendingSites.filter(
        (site) => site.path[0] !== "services" || !excluded.has(String(site.path[1])),
      ),
    }),
    paths.root,
  );
  return { materialized: true as const, paths, landofile: admitted, resolution: effective };
});

export const loadGlobalPlan = Effect.fnUntraced(function* (
  options: { readonly services?: ReadonlyArray<string> } = {},
): Effect.fn.Return<LoadGlobalPlanResult, LoadGlobalPlanError, LoadGlobalPlanServices> {
  const providerId = yield* globalCreateProviderId();
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(providerId);
  const loaded = yield* withGlobalResolutionCapabilities(
    providerId,
    provider.capabilities,
    readGlobalLandofile(options),
  );
  if (!loaded.materialized) return loaded;
  const { paths, landofile } = loaded;
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
