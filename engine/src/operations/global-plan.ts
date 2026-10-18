import { join } from "node:path";
import { Effect } from "effect";

import { GlobalAppError, type LandofileParseError, type LandofileValidationError } from "@lando/sdk/errors";
import { mergeLandofiles } from "@lando/sdk/landofile";
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

import { buildLandofileLoadScope, compileLandofileLayer } from "@lando/landofile/compile";
import { DEFAULT_LANDOFILE, DEFAULT_POST_LANDOFILES, DEFAULT_PRE_LANDOFILES } from "@lando/landofile/merge";
import { parseLandofile } from "@lando/landofile/parser";
import { validateLandofile } from "@lando/landofile/validation";

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

export const decodeGlobalLandofile = (input: {
  readonly file: string;
  readonly content: string;
  readonly cwd: string;
}): Effect.Effect<LandofileShape, LandofileParseError | LandofileValidationError> =>
  parseLandofile(input).pipe(
    Effect.flatMap((parsed) =>
      buildLandofileLoadScope([{ file: input.file, value: parsed }]).pipe(
        Effect.flatMap((scope) => compileLandofileLayer(input.file, parsed, scope)),
      ),
    ),
    Effect.flatMap((overlay) => validateLandofile(input.file, mergeLandofiles([overlay]))),
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
  GlobalAppError | FileSystemError | LandofileParseError | LandofileValidationError,
  FileSystem | GlobalAppService
> {
  const globalApp = yield* GlobalAppService;
  const fileSystem = yield* FileSystem;
  const paths = yield* globalApp.paths;
  const exists = yield* fileSystem.exists(paths.distLandofile);
  if (!exists) return { materialized: false, paths };

  const rawLayers: Array<{ readonly file: string; readonly value: unknown }> = [];
  for (const basename of [...DEFAULT_PRE_LANDOFILES, DEFAULT_LANDOFILE, ...DEFAULT_POST_LANDOFILES]) {
    const file = join(paths.root, basename);
    if (!(yield* fileSystem.exists(file))) continue;
    const content = yield* fileSystem.readText(file);
    rawLayers.push({ file, value: yield* parseLandofile({ file, content, cwd: paths.root }) });
  }
  const scope = yield* buildLandofileLoadScope(rawLayers);
  const layers = yield* Effect.forEach(rawLayers, ({ file, value }) =>
    compileLandofileLayer(file, value, scope),
  );
  const landofile = yield* validateLandofile(paths.userLandofile, {
    ...mergeLandofiles(layers),
    name: "global",
    provider: MANAGED_PROVIDER_ID,
  });
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
