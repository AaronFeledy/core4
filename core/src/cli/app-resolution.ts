import { dirname } from "node:path";

import { type Context, Effect, Option } from "effect";

import {
  AppIdReservedError,
  type LandofileFormConflictError,
  type LandofileIncludeError,
  type LandofileLockMismatchError,
  type LandofileNotFoundError,
  LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  type LandofileValidationError,
  LandofileVersionConstraintError,
  type NotImplementedError,
} from "@lando/sdk/errors";
import type { AppPlan, AppRef, LandofileShape } from "@lando/sdk/schema";
import { type LandofileService, Renderer } from "@lando/sdk/services";

import {
  type VersionConstraintEntry,
  evaluateVersionConstraints,
  getVersionConstraintEntries,
  isVersionConstraintSkipped,
} from "../config/version-constraint.ts";
import { LANDOFILE_NAME } from "../landofile/discovery.ts";
import { resolveLandofileIncludes } from "../landofile/includes.ts";
import { landofileLayerPaths } from "../landofile/layers.ts";
import { findDiscoveredLandofilePath, loadLandofileFile, loadLandofileLayers } from "../landofile/service.ts";
import { CORE_VERSION } from "../version.ts";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "./command-warnings.ts";

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
  | LandofileFormConflictError
  | NotImplementedError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileVersionConstraintError
  | AppIdReservedError;

export const assertUserAppIdNotReserved = (
  landofile: LandofileShape,
): Effect.Effect<void, AppIdReservedError> => {
  const resolved = landofile.name ?? "app";
  return RESERVED_APP_IDS.has(resolved)
    ? Effect.fail(new AppIdReservedError({ reserved: resolved }))
    : Effect.void;
};

export interface LandoVersionConstraintOptions {
  readonly runningVersion?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sourcePath?: string;
}

const discoveredLandofilePath = (): Effect.Effect<
  { readonly filePath: string; readonly appRoot: string } | undefined
> =>
  Effect.promise(() =>
    findDiscoveredLandofilePath(process.cwd()).then(
      (result) => result,
      () => undefined,
    ),
  );

const RANGE_SYNTAX_REMEDIATION = 'Use a valid semver range such as ">=4.1 <5", "^4.0.0", or "~4.1".';

const VERSION_CONSTRAINT_REMEDIATION =
  "Run `lando update` to move to a satisfying Lando version, or edit the `lando:` constraint in your Landofile.";

const warnConstraintSkipped = (
  unsatisfied: ReadonlyArray<VersionConstraintEntry>,
  runningVersion: string,
): Effect.Effect<void> => {
  const message = `Skipping unsatisfied Lando version constraint ${unsatisfied
    .map((entry) => `"${entry.range}"`)
    .join(", ")} (running ${runningVersion}); LANDO_SKIP_VERSION_CONSTRAINT is set.`;
  return Effect.gen(function* () {
    yield* Effect.forEach(
      unsatisfied,
      (entry) =>
        recordCommandWarning({
          code: "LANDO_VERSION_CONSTRAINT_SKIPPED",
          message,
          remediation: VERSION_CONSTRAINT_REMEDIATION,
          context: {
            range: entry.range,
            source: entry.source,
            layer: entry.layer,
            order: String(entry.order),
            runningVersion,
          },
        }),
      { discard: true },
    );
    const renderer = yield* Effect.serviceOption(Renderer);
    const machineOutput = yield* commandWarningsUseMachineOutput;
    if (!machineOutput && Option.isSome(renderer)) {
      yield* renderer.value.message.warn(message).pipe(Effect.catchAll(() => Effect.void));
    }
  });
};

export const assertLandoVersionConstraint = (
  landofile: LandofileShape,
  options?: LandoVersionConstraintOptions,
): Effect.Effect<void, LandofileParseError | LandofileVersionConstraintError> => {
  const constraints = getVersionConstraintEntries(landofile, options?.sourcePath ?? LANDOFILE_NAME);
  if (constraints.length === 0) return Effect.void;

  const runningVersion = options?.runningVersion ?? CORE_VERSION;
  const env = options?.env ?? process.env;
  const { invalid, unsatisfied } = evaluateVersionConstraints(constraints, runningVersion);

  const bad = invalid[0];
  if (bad !== undefined)
    return Effect.fail(
      new LandofileParseError({
        message: `Landofile "lando:" is not a valid semver range: "${bad.range}". ${RANGE_SYNTAX_REMEDIATION}`,
        filePath: bad.source,
        line: undefined,
        column: undefined,
      }),
    );

  if (unsatisfied.length === 0) return Effect.void;
  if (isVersionConstraintSkipped(env)) return warnConstraintSkipped(unsatisfied, runningVersion);

  return Effect.fail(
    new LandofileVersionConstraintError({
      message: `The running Lando version ${runningVersion} does not satisfy the Landofile \`lando:\` constraint ${unsatisfied
        .map((entry) => `"${entry.range}" (${entry.source}; ${entry.layer} layer, order ${entry.order})`)
        .join(", ")}.`,
      constraints: unsatisfied,
      runningVersion,
      remediation: VERSION_CONSTRAINT_REMEDIATION,
    }),
  );
};

export const loadUserLandofile = (
  landofileService: Context.Tag.Service<typeof LandofileService>,
): Effect.Effect<LandofileShape, UserLandofileError> =>
  landofileService.discover.pipe(
    Effect.flatMap((landofile) => {
      if (landofile.includes === undefined || landofile.includes.length === 0) {
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
                  cause instanceof Error ? cause.message : "Failed to locate the discovered Landofile root.",
                filePath: process.cwd(),
                line: undefined,
                column: undefined,
                cause,
              }),
      }).pipe(
        Effect.flatMap(({ appRoot, filePath }) =>
          resolveLandofileIncludes({ landofile, appRoot, sourcePath: filePath }),
        ),
        Effect.map((resolved) => ({ landofile: resolved, sourcePath: undefined })),
      );
    }),
    Effect.tap(({ landofile }) => assertUserAppIdNotReserved(landofile)),
    Effect.tap(({ landofile, sourcePath }) =>
      assertLandoVersionConstraint(landofile, sourcePath === undefined ? undefined : { sourcePath }),
    ),
    Effect.map(({ landofile }) => landofile),
  );

export const loadUserLandofileFile = (
  filePath: string,
): Effect.Effect<LandofileShape, UserLandofileError> => {
  const appRoot = dirname(filePath);
  return (
    landofileLayerPaths(appRoot).some(
      ({ yamlPath, typescriptPath }) => filePath === yamlPath || filePath === typescriptPath,
    )
      ? loadLandofileLayers(appRoot, filePath)
      : loadLandofileFile(filePath).pipe(
          Effect.flatMap((landofile) =>
            landofile.includes === undefined || landofile.includes.length === 0
              ? Effect.succeed(landofile)
              : resolveLandofileIncludes({ landofile, appRoot, sourcePath: filePath }),
          ),
        )
  ).pipe(
    Effect.tap(assertUserAppIdNotReserved),
    Effect.tap((landofile) => assertLandoVersionConstraint(landofile, { sourcePath: filePath })),
  );
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
 * the same LandofileService discovery and validation path as cwd resolution.
 */
export const loadUserLandofileAt = (
  landofileService: Context.Tag.Service<typeof LandofileService>,
  root: string,
): Effect.Effect<LandofileShape, UserLandofileError> =>
  withResolvedCwd(root, loadUserLandofile(landofileService));
