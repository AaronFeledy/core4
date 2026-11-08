import { dirname } from "node:path";

import { type Context, Effect } from "effect";

import {
  AppIdReservedError,
  type LandofileParseError,
  type LandofileVersionConstraintError,
} from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan, AppRef, LandofileShape, LoadScopedLandofile } from "@lando/sdk/schema";
import { normalizeAppSlug } from "@lando/sdk/schema";
import type { LandofileService, UserLandofileError } from "@lando/sdk/services";

export type { UserLandofileError };

import { compileLandofileFile } from "./file-compile.ts";
import { landofileLayerPaths, presentLandofileLayers, representativeLandofileLayer } from "./layers.ts";
import { withDiscoveryCwd } from "./operation-discovery.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { loadLandofileLayers } from "./service.ts";

const RESERVED_APP_IDS: ReadonlySet<string> = new Set(["global"]);

export interface ResolvedAppTarget {
  readonly plan: AppPlan;
  readonly root: AbsolutePath;
  readonly app: AppRef;
  readonly landofile?: LoadScopedLandofile;
}

export const userAppRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

export const assertUserAppIdNotReserved = (
  landofile: Pick<LandofileShape, "name">,
): Effect.Effect<void, AppIdReservedError> => {
  const id = normalizeAppSlug(landofile.name ?? "app", "");
  return RESERVED_APP_IDS.has(id) ? Effect.fail(new AppIdReservedError({ reserved: id })) : Effect.void;
};

export const withResolvedCwd = <A, E, R>(
  root: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LandofileParseError, R> => withDiscoveryCwd(root, use);

export interface UserAppResolutionOptions {
  readonly inputs?: LandofileRuntimeInputs;
  readonly assertVersionConstraint: (
    landofile: LandofileShape,
    sourcePath?: string,
  ) => Effect.Effect<void, LandofileParseError | LandofileVersionConstraintError>;
}

export interface UserAppResolution {
  readonly loadUserLandofile: (
    landofileService: Context.Service.Shape<typeof LandofileService>,
  ) => Effect.Effect<LoadScopedLandofile, UserLandofileError>;
  readonly loadUserLandofileAt: (
    landofileService: Context.Service.Shape<typeof LandofileService>,
    root: string,
  ) => Effect.Effect<LoadScopedLandofile, UserLandofileError>;
  readonly loadUserLandofileFile: (
    filePath: string,
  ) => Effect.Effect<LoadScopedLandofile, UserLandofileError>;
}

export const makeUserAppResolution = (options: UserAppResolutionOptions): UserAppResolution => {
  const loadUserLandofile = (
    landofileService: Context.Service.Shape<typeof LandofileService>,
  ): Effect.Effect<LoadScopedLandofile, UserLandofileError> =>
    landofileService.discover.pipe(
      Effect.flatMap((landofile) => {
        return presentLandofileLayers(landofile.context.appRoot).pipe(
          Effect.map((layers) => ({ landofile, sourcePath: representativeLandofileLayer(layers)?.filePath })),
        );
      }),
      Effect.tap(({ landofile }) => assertUserAppIdNotReserved(landofile.document)),
      Effect.tap(({ landofile, sourcePath }) =>
        options.assertVersionConstraint(landofile.document, sourcePath),
      ),
      Effect.map(({ landofile }) => landofile),
    );

  const loadUserLandofileFile = (
    filePath: string,
  ): Effect.Effect<LoadScopedLandofile, UserLandofileError> => {
    const appRoot = dirname(filePath);
    return (
      landofileLayerPaths(appRoot).some(
        ({ yamlPath, typescriptPath }) => filePath === yamlPath || filePath === typescriptPath,
      )
        ? loadLandofileLayers(appRoot, filePath, options.inputs)
        : compileLandofileFile(filePath, undefined, options.inputs).pipe(
            Effect.map(({ landofile }) => landofile),
          )
    ).pipe(
      Effect.tap((landofile) => assertUserAppIdNotReserved(landofile.document)),
      Effect.tap((landofile) => options.assertVersionConstraint(landofile.document, filePath)),
    );
  };

  return {
    loadUserLandofile,
    loadUserLandofileAt: (landofileService, root) =>
      withResolvedCwd(root, loadUserLandofile(landofileService)),
    loadUserLandofileFile,
  };
};
