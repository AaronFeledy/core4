import { dirname } from "node:path";

import { type Context, Effect } from "effect";

import {
  AppIdReservedError,
  type LandofileIncludeError,
  type LandofileLockMismatchError,
  type LandofileNotFoundError,
  LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  type LandofileValidationError,
  type NotImplementedError,
} from "@lando/sdk/errors";
import type { AppPlan, AppRef, LandofileShape } from "@lando/sdk/schema";
import type { LandofileService } from "@lando/sdk/services";

import { resolveLandofileIncludes } from "../landofile/includes.ts";
import { findDiscoveredLandofilePath, loadLandofileFile } from "../landofile/service.ts";

const RESERVED_APP_IDS: ReadonlySet<string> = new Set(["global"]);

/**
 * A resolved app captured once by `resolveApp`/`openLandoRuntime`. App-handle
 * methods reuse this so they operate against the captured plan and root instead
 * of re-discovering from the host's current working directory.
 */
export interface ResolvedAppTarget {
  readonly plan: AppPlan;
  readonly root: string;
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
  | NotImplementedError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | AppIdReservedError;

export const assertUserAppIdNotReserved = (
  landofile: LandofileShape,
): Effect.Effect<void, AppIdReservedError> => {
  const resolved = landofile.name ?? "app";
  return RESERVED_APP_IDS.has(resolved)
    ? Effect.fail(new AppIdReservedError({ reserved: resolved }))
    : Effect.void;
};

export const loadUserLandofile = (
  landofileService: Context.Tag.Service<typeof LandofileService>,
): Effect.Effect<LandofileShape, UserLandofileError> =>
  landofileService.discover.pipe(
    Effect.flatMap((landofile) => {
      if (landofile.includes === undefined || landofile.includes.length === 0)
        return Effect.succeed(landofile);
      return Effect.tryPromise({
        try: () => findDiscoveredLandofilePath(process.cwd()),
        catch: (cause) =>
          cause instanceof LandofileParseError
            ? cause
            : new LandofileParseError({
                message:
                  cause instanceof Error ? cause.message : "Failed to locate the discovered Landofile root.",
                filePath: process.cwd(),
                line: undefined,
                column: undefined,
                cause,
              }),
      }).pipe(Effect.flatMap(({ appRoot }) => resolveLandofileIncludes({ landofile, appRoot })));
    }),
    Effect.tap(assertUserAppIdNotReserved),
  );

export const loadUserLandofileFile = (filePath: string): Effect.Effect<LandofileShape, UserLandofileError> =>
  loadLandofileFile(filePath).pipe(
    Effect.flatMap((landofile) => {
      if (landofile.includes === undefined || landofile.includes.length === 0)
        return Effect.succeed(landofile);
      return resolveLandofileIncludes({ landofile, appRoot: dirname(filePath) });
    }),
    Effect.tap(assertUserAppIdNotReserved),
  );

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

/**
 * Process-wide guard serializing every transient `process.chdir` used during
 * app resolution. `process.cwd()` is process-global, so concurrent root-bound
 * resolutions in a retained runtime must not interleave their chdir regions.
 */
const cwdResolutionLock = Effect.unsafeMakeSemaphore(1);

/**
 * Runs `use` with `process.cwd()` temporarily set to `root`, restoring it after.
 * The chdir region is held under the shared cwd lock. A no-op when `root` already
 * is the current working directory so the common case takes no lock.
 */
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

/**
 * Root-aware variant of {@link loadUserLandofile}: resolves the Landofile,
 * includes, and reserved-id validation at an explicit `root` rather than the
 * host's current working directory. Reuses the injected `LandofileService` so
 * the canonical discovery + beta validation path is preserved.
 */
export const loadUserLandofileAt = (
  landofileService: Context.Tag.Service<typeof LandofileService>,
  root: string,
): Effect.Effect<LandofileShape, UserLandofileError> =>
  withResolvedCwd(root, loadUserLandofile(landofileService));
