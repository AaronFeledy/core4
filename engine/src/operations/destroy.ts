import { basename } from "node:path";
import { findAppRoot } from "@lando/landofile/discovery";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
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
  type ManagedFileTransactionGuard,
  type PathsService,
  RuntimeProviderRegistry,
  type StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { TeardownProvider, resolveAppPlacement } from "../providers/app-placement.ts";
import { BuildOwner } from "../services/build-owner.ts";
import { removeAppBuildOutput } from "../services/build-transcript-cleanup.ts";
import { withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  resolveTeardownResolution,
  teardownResolutionAt,
  validateResolvedAppTarget,
} from "./applied-state-target.ts";
import { executeTeardown } from "./destroy-execute.ts";
import { prepareDestroyFileSync } from "./destroy-file-sync.ts";
import { prepareDestroyOwners } from "./destroy-owners.ts";
import { planUserTeardown } from "./destroy-plan.ts";
import { withMissingDestroyRoot } from "./destroy-resolution.ts";
import { type RetirementReceipt, prepareSupersededRealizations } from "./superseded-realizations.ts";

export type DestroyAppError = SdkDestroyAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { DestroyAppOptions, DestroyAppResult } from "@lando/sdk/app";

type DestroyAppServices =
  | ManagedFileTransactionGuard
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
    { id: id ?? root, root, kind: resolution.kind === "applied" ? resolution.target.app.kind : "user" },
    Effect.gen(function* () {
      let retire: Effect.Effect<RetirementReceipt | undefined, SdkDestroyAppError> | undefined;
      if (resolution.kind === "applied" && request.missingRoot !== true)
        yield* validateResolvedAppTarget(resolution.target);
      if (resolution.kind === "applied" && resolution.target.app.kind === "user") {
        const desired = resolution.target;
        const placement = yield* resolveAppPlacement(
          resolution.reconcileApp ?? desired.app,
          desired.plan.provider,
          yield* TeardownProvider,
        );
        const target = placement.plan === undefined ? desired : { ...desired, plan: placement.plan };
        if (placement.superseded.length > 0) {
          const registry = yield* RuntimeProviderRegistry;
          yield* registry.resolveTeardownEvidence(target.root, {
            ...target.app,
            id: placement.plan?.id ?? placement.superseded[0]?.id ?? target.app.id,
          });
          const provider = yield* registry.select(placement.plan ?? placement.superseded[0] ?? target.plan);
          yield* prepareDestroyFileSync(target, provider);
          retire = yield* prepareSupersededRealizations(target, placement.superseded, {
            provider,
            volumes: options.volumes === true,
            purgeCaches: options.purgeCaches === true,
            narration: "teardown",
          });
        }
      }
      const plan = yield* planUserTeardown(resolution, options, request);
      return yield* executeTeardown({ ...plan, ...(retire === undefined ? {} : { retire }) });
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
      yield* prepareDestroyOwners(target.root, { ...options, target });
      const registry = yield* RuntimeProviderRegistry;
      const placement = yield* resolveAppPlacement(target.app, target.plan.provider, yield* TeardownProvider);
      const app = {
        ...target.app,
        id: placement.plan?.id ?? placement.superseded[0]?.id ?? target.app.id,
      };
      const resolution: TeardownResolution =
        target.landofile === undefined
          ? {
              kind: "applied",
              target,
              ownership: yield* registry
                .resolveTeardownEvidence(target.root, app)
                .pipe(
                  Effect.map((evidence) => (evidence.kind === "absent" ? [] : (evidence.ownership ?? []))),
                ),
            }
          : yield* teardownResolutionAt(target.root, true, () => Effect.succeed(target), app);
      const result = yield* runTeardown(resolution, options ?? {}, { desired: Effect.succeed(target) });
      yield* afterSuccess ?? Effect.void;
      return result;
    }),
  );
});

export const destroyApp = Effect.fn("AppOperation.destroy")(
  function* (
    options: DestroyAppOptions = {},
    target?: ResolvedAppTarget,
  ): Effect.fn.Return<DestroyAppResult, DestroyAppError, DestroyAppServices> {
    if (options.providerId !== undefined) {
      const { providerId } = options;
      if (target !== undefined && target.plan.provider !== providerId)
        return yield* Effect.fail(
          new AppResolveError({
            message: "The explicit provider differs from the app handle's applied provider.",
            reason: "mismatch",
            detail: "provider",
            remediation: `Run \`lando destroy --provider=${providerId} --yes\` from the app directory.`,
          }),
        );
    }
    if (target !== undefined) return yield* destroyAppForTarget(options, target);
    const root = (yield* findAppRoot()) ?? (yield* discoveryCwd());
    return yield* withAppMutationLock(
      { kind: "user", id: root, root },
      Effect.gen(function* () {
        yield* prepareDestroyOwners(root, options);
        const resolution = yield* resolveTeardownResolution;
        // An explicit provider only tears down what that provider holds; it never falls back to the desired plan.
        const scopedProvider = yield* TeardownProvider;
        if (resolution.kind === "absent" && scopedProvider !== undefined) {
          const builtImages = yield* removeAppBuildOutput(
            BuildOwner.root(resolution.root),
            String(scopedProvider),
            String(scopedProvider),
            { images: options.purgeCaches === true ? "remove" : "release" },
          );
          return {
            app: basename(resolution.root),
            outcome: "unchanged" as const,
            servicesDestroyed: [],
            dataVolumesRemoved: false,
            cacheVolumesRemoved: false,
            snapshotsRemoved: 0,
            builtImages,
          };
        }
        return yield* runTeardown(resolution, options, { desired: resolveDesiredAppTarget });
      }),
    );
  },
  (effect, options?: DestroyAppOptions, _target?: ResolvedAppTarget) =>
    options?.providerId === undefined
      ? effect
      : Effect.provideService(effect, TeardownProvider, options.providerId),
);

export const destroyAppAtRoot = Effect.fn("AppOperation.destroyAtRoot")(
  function* (
    root: string,
    options: DestroyAppOptions = {},
    retryCommand?: string,
  ): Effect.fn.Return<
    DestroyAppResult,
    DestroyAppError | FileIoError | FileNotFoundError | FilePermissionError,
    DestroyAppServices | FileSystem
  > {
    return yield* withMissingDestroyRoot(root, options, ({ resolution, candidates }) =>
      runTeardown(resolution, options, {
        desired: Effect.succeed(undefined),
        snapshotRoots: candidates,
        missingRoot: true,
        ...(retryCommand === undefined ? {} : { retryCommand }),
      }),
    );
  },
  (effect, _root: string, options?: DestroyAppOptions, _retryCommand?: string) =>
    options?.providerId === undefined
      ? effect
      : Effect.provideService(effect, TeardownProvider, options.providerId),
);
