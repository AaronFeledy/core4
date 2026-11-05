import { basename } from "node:path";
import type {
  DestroyAppOptions,
  DestroyAppResult,
  DestroyAppError as SdkDestroyAppError,
} from "@lando/sdk/app";
import {
  AppResolveError,
  type ComposeKeyRejectedError,
  type FileIoError,
  type FileNotFoundError,
  type FilePermissionError,
  type LandofileLoadExpressionError,
} from "@lando/sdk/errors";
import {
  type AppPlanner,
  type DataMover,
  type EventService,
  type FileSystem,
  type LandofileService,
  type PathsService,
  RuntimeProviderRegistry,
  type StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { TeardownProvider } from "../providers/app-placement.ts";
import { withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  resolveTeardownResolution,
  teardownResolutionAt,
  validateResolvedAppTarget,
} from "./applied-state-target.ts";
import { executeTeardown } from "./destroy-execute.ts";
import { planUserTeardown } from "./destroy-plan.ts";
import { resolveMissingDestroyRoot } from "./destroy-resolution.ts";

export type DestroyAppError = SdkDestroyAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { DestroyAppOptions, DestroyAppResult } from "@lando/sdk/app";

type DestroyAppServices =
  | AppPlanner
  | DataMover
  | EventService
  | LandofileService
  | PathsService
  | PrivateFileAccessService
  | StateStore
  | RuntimeProviderRegistry;

const runTeardown = Effect.fnUntraced(function* <E, R>(
  resolution: TeardownResolution,
  options: DestroyAppOptions,
  request: Parameters<typeof planUserTeardown<E, R>>[2],
) {
  const root = resolution.kind === "applied" ? resolution.target.root : resolution.root;
  const id =
    resolution.kind === "applied"
      ? resolution.target.app.id
      : resolution.kind === "orphans"
        ? resolution.groups[0]?.appId
        : resolution.kind === "owned"
          ? resolution.ownership[0]?.appIds[0]
          : undefined;
  return yield* withAppMutationLock(
    { id: id ?? root, root },
    Effect.gen(function* () {
      if (resolution.kind === "applied" && request.missingRoot !== true)
        yield* validateResolvedAppTarget(resolution.target);
      const plan = yield* planUserTeardown(resolution, options, request);
      return yield* executeTeardown(plan);
    }),
  );
});

export const destroyAppForTarget = Effect.fn("AppOperation.destroyForTarget")(function* (
  options: DestroyAppOptions | undefined,
  target: ResolvedAppTarget,
  afterSuccess?: Effect.Effect<void>,
): Effect.fn.Return<DestroyAppResult, SdkDestroyAppError, DestroyAppServices> {
  return yield* withAppMutationLock(
    target.app,
    Effect.gen(function* () {
      yield* validateResolvedAppTarget(target);
      const registry = yield* RuntimeProviderRegistry;
      const resolution: TeardownResolution =
        target.landofile === undefined
          ? {
              kind: "applied",
              target,
              ownership: yield* registry
                .resolveTeardownEvidence(target.root)
                .pipe(
                  Effect.map((evidence) => (evidence.kind === "absent" ? [] : (evidence.ownership ?? []))),
                ),
            }
          : yield* teardownResolutionAt(target.root, true, (plan) =>
              validateResolvedAppTarget({
                plan,
                root: plan.root,
                app: { ...target.app, id: plan.id, root: plan.root },
              }),
            );
      const result = yield* runTeardown(resolution, options ?? {}, { desired: Effect.succeed(target) });
      yield* afterSuccess ?? Effect.void;
      return result;
    }),
  );
});

export const destroyApp = Effect.fn("AppOperation.destroy")(function* (
  options: DestroyAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<DestroyAppResult, DestroyAppError, DestroyAppServices> {
  if (options.providerId !== undefined) {
    const { providerId, ...scopedOptions } = options;
    if (target !== undefined && target.plan.provider !== providerId)
      return yield* Effect.fail(
        new AppResolveError({
          message: "The explicit provider differs from the app handle's applied provider.",
          reason: "mismatch",
          detail: "provider",
          remediation: `Run \`lando destroy --provider=${providerId} --yes\` from the app directory.`,
        }),
      );
    return yield* destroyApp(scopedOptions, target).pipe(Effect.provideService(TeardownProvider, providerId));
  }
  if (target !== undefined) return yield* destroyAppForTarget(options, target);
  const resolution = yield* resolveTeardownResolution;
  // An explicit provider only tears down what that provider holds; it never falls back to the desired plan.
  if (resolution.kind === "absent" && (yield* TeardownProvider) !== undefined)
    return {
      app: basename(resolution.root),
      outcome: "unchanged",
      servicesDestroyed: [],
      volumesRemoved: false,
      snapshotsRemoved: 0,
    };
  return yield* runTeardown(resolution, options, { desired: resolveDesiredAppTarget });
});

export const destroyAppAtRoot = Effect.fn("AppOperation.destroyAtRoot")(function* (
  root: string,
  options: DestroyAppOptions = {},
): Effect.fn.Return<
  DestroyAppResult,
  DestroyAppError | FileIoError | FileNotFoundError | FilePermissionError,
  DestroyAppServices | FileSystem
> {
  if (options.providerId !== undefined) {
    const { providerId, ...scopedOptions } = options;
    return yield* destroyAppAtRoot(root, scopedOptions).pipe(
      Effect.provideService(TeardownProvider, providerId),
    );
  }
  const { resolution, candidates } = yield* resolveMissingDestroyRoot(root);
  return yield* runTeardown(resolution, options, {
    desired: Effect.succeed(undefined),
    snapshotRoots: candidates,
    missingRoot: true,
  });
});
