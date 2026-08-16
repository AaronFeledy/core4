import { dirname } from "node:path";

import { type Context, Effect } from "effect";

import {
  AppIdReservedError,
  type ComposeKeyRejectedError,
  type LandofileFormConflictError,
  type LandofileImportRefMisuseError,
  type LandofileIncludeError,
  type LandofileLoadLimitError,
  type LandofileLoadOutsideRootError,
  type LandofileLockMismatchError,
  type LandofileNotFoundError,
  LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  type LandofileUnknownEventError,
  type LandofileValidationError,
  type LandofileVersionConstraintError,
  type NotImplementedError,
  type ToolingIncludeCycleError,
} from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan, AppRef, LandofileShape } from "@lando/sdk/schema";
import type { LandofileService } from "@lando/sdk/services";

import { hasResolvableIncludes, resolveLandofileIncludes } from "./includes.ts";
import { landofileLayerPaths } from "./layers.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { findDiscoveredLandofilePath, loadLandofileFile, loadLandofileLayers } from "./service.ts";

const RESERVED_APP_IDS: ReadonlySet<string> = new Set(["global"]);

export interface ResolvedAppTarget {
  readonly plan: AppPlan;
  readonly root: AbsolutePath;
  readonly app: AppRef;
  readonly landofile?: LandofileShape;
}

export const userAppRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

export type UserLandofileError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileUnknownEventError
  | LandofileFormConflictError
  | NotImplementedError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileImportRefMisuseError
  | LandofileLoadLimitError
  | LandofileLoadOutsideRootError
  | ToolingIncludeCycleError
  | LandofileVersionConstraintError
  | AppIdReservedError
  | ComposeKeyRejectedError;

export const assertUserAppIdNotReserved = (
  landofile: LandofileShape,
): Effect.Effect<void, AppIdReservedError> => {
  const resolved = landofile.name ?? "app";
  return RESERVED_APP_IDS.has(resolved)
    ? Effect.fail(new AppIdReservedError({ reserved: resolved }))
    : Effect.void;
};

const enterDir = (root: string): Effect.Effect<string, LandofileParseError> =>
  Effect.try({
    try: () => {
      const original = process.cwd();
      process.chdir(root);
      return original;
    },
    catch: (cause) =>
      new LandofileParseError({
        message: cause instanceof Error ? cause.message : `Unable to enter the app directory at ${root}.`,
        filePath: root,
        line: undefined,
        column: undefined,
        cause,
      }),
  });

const cwdResolutionLock = Effect.unsafeMakeSemaphore(1);

export const withResolvedCwd = <A, E, R>(
  root: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LandofileParseError, R> =>
  cwdResolutionLock.withPermits(1)(
    Effect.suspend(() =>
      root === process.cwd()
        ? use
        : Effect.acquireUseRelease(
            enterDir(root),
            () => use,
            (original) => Effect.sync(() => process.chdir(original)),
          ),
    ),
  );

export interface UserAppResolutionOptions {
  readonly inputs?: LandofileRuntimeInputs;
  readonly assertVersionConstraint: (
    landofile: LandofileShape,
    sourcePath?: string,
  ) => Effect.Effect<void, LandofileParseError | LandofileVersionConstraintError>;
}

export interface UserAppResolution {
  readonly loadUserLandofile: (
    landofileService: Context.Tag.Service<typeof LandofileService>,
  ) => Effect.Effect<LandofileShape, UserLandofileError>;
  readonly loadUserLandofileAt: (
    landofileService: Context.Tag.Service<typeof LandofileService>,
    root: string,
  ) => Effect.Effect<LandofileShape, UserLandofileError>;
  readonly loadUserLandofileFile: (filePath: string) => Effect.Effect<LandofileShape, UserLandofileError>;
}

export const makeUserAppResolution = (options: UserAppResolutionOptions): UserAppResolution => {
  const discoveredLandofilePath = (): Effect.Effect<
    { readonly filePath: string; readonly appRoot: string } | undefined
  > =>
    Effect.promise(() =>
      findDiscoveredLandofilePath(process.cwd()).then(
        (result) => result,
        () => undefined,
      ),
    );

  const loadUserLandofile = (
    landofileService: Context.Tag.Service<typeof LandofileService>,
  ): Effect.Effect<LandofileShape, UserLandofileError> =>
    landofileService.discover.pipe(
      Effect.flatMap((landofile) => {
        if (!hasResolvableIncludes(landofile)) {
          return discoveredLandofilePath().pipe(
            Effect.map((discovered) => ({ landofile, sourcePath: discovered?.filePath })),
          );
        }
        return Effect.tryPromise({
          try: () => findDiscoveredLandofilePath(process.cwd()),
          catch: (cause) =>
            cause instanceof LandofileParseError
              ? cause
              : new LandofileParseError({
                  message:
                    cause instanceof Error
                      ? cause.message
                      : "Failed to locate the discovered Landofile root.",
                  filePath: process.cwd(),
                  line: undefined,
                  column: undefined,
                  cause,
                }),
        }).pipe(
          Effect.flatMap(({ appRoot, filePath }) =>
            resolveLandofileIncludes({
              landofile,
              appRoot,
              sourcePath: filePath,
              ...(options.inputs?.ports === undefined ? {} : { ports: options.inputs.ports }),
            }),
          ),
          Effect.map((resolved) => ({ landofile: resolved, sourcePath: undefined })),
        );
      }),
      Effect.tap(({ landofile }) => assertUserAppIdNotReserved(landofile)),
      Effect.tap(({ landofile, sourcePath }) => options.assertVersionConstraint(landofile, sourcePath)),
      Effect.map(({ landofile }) => landofile),
    );

  const loadUserLandofileFile = (filePath: string): Effect.Effect<LandofileShape, UserLandofileError> => {
    const appRoot = dirname(filePath);
    return (
      landofileLayerPaths(appRoot).some(
        ({ yamlPath, typescriptPath }) => filePath === yamlPath || filePath === typescriptPath,
      )
        ? loadLandofileLayers(appRoot, filePath, options.inputs)
        : loadLandofileFile(filePath, undefined, options.inputs).pipe(
            Effect.flatMap((landofile) =>
              resolveLandofileIncludes({
                landofile,
                appRoot,
                sourcePath: filePath,
                ...(options.inputs?.ports === undefined ? {} : { ports: options.inputs.ports }),
              }),
            ),
          )
    ).pipe(
      Effect.tap(assertUserAppIdNotReserved),
      Effect.tap((landofile) => options.assertVersionConstraint(landofile, filePath)),
    );
  };

  return {
    loadUserLandofile,
    loadUserLandofileAt: (landofileService, root) =>
      withResolvedCwd(root, loadUserLandofile(landofileService)),
    loadUserLandofileFile,
  };
};
