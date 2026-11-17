import { stat } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import { findAppRoot } from "@lando/landofile/discovery";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import type { StopAppError as SdkStopAppError, StopAppOptions, StopAppResult } from "@lando/sdk/app";
import {
  AppResolveError,
  type ComposeKeyRejectedError,
  FileSyncStopError,
  type LandofileLoadExpressionError,
  isErrnoCode,
} from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, type AppRef, type ProviderId } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type EventService,
  type LandofileService,
  type ManagedFileTransactionGuard,
  type PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Result } from "effect";

import {
  type ResolvedAppTarget,
  resolveDesiredAppTarget,
  resolveDesiredAppTargetAtRoot,
} from "../landofile/app-resolution.ts";
import { routeOwnerFromPlan, routeOwnerFromRoot } from "../lifecycle/route-owner.ts";
import { withdrawOwnerRoutes } from "../lifecycle/route-withdrawal.ts";
import {
  verifyActiveVolumeCoordination,
  withPlanVolumeCoordination,
} from "../lifecycle/volume-coordination.ts";
import { TeardownProvider, resolveAppPlacement } from "../providers/app-placement.ts";
import { shellArg } from "../services/shell-quote.ts";
import { readDiscardableStart } from "./accelerated-start-disposal.ts";
import { cleanupAppWorkers } from "./destroy-provider.ts";
import { appLockTarget, canonicalMissingAppRoot, withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  appliedStateTarget,
  missingRootAppliedTarget,
  teardownDesiredOrUnchanged,
  teardownResolutionAtRoot,
  validateResolvedAppTarget,
} from "./applied-state-target.ts";
import { landofilePresentAt } from "./landofile-events.ts";
import { prepareMissingRootStartDisposal } from "./missing-root-start-disposal.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
import {
  ownedCleanupChanged,
  prepareOwnedResourceCleanup,
  tearDownOwnedResources,
} from "./owned-resource-teardown.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";
import { stopIdleApp } from "./stop-idle.ts";
import { preflightStopApp, stopAppWithPlanUnlocked } from "./stop-internal.ts";
import { type RetirementReceipt, retireSupersededRealizations } from "./superseded-realizations.ts";

export type StopAppError = SdkStopAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { StopAppOptions, StopAppResult } from "@lando/sdk/app";

export type StopAppAtRootOptions = StopAppOptions & { readonly providerId?: ProviderId };

type StopAppServices =
  | ManagedFileTransactionGuard
  | AppPlanner
  | EventService
  | LandofileService
  | PathsService
  | PrivateFileAccessService
  | RuntimeProviderRegistry
  | StateStore;
type StopExecution = {
  readonly reconcileApp?: AppRef;
  readonly revalidate: boolean;
  readonly requireAppliedEvidence: boolean;
  readonly runInitEvents?: boolean;
  readonly cleanupOwnership?: boolean;
  /** No project folder exists, so there is no retained writer to verify or drain. */
  readonly missingRoot?: boolean;
};

/** What one stop body needs from the entry point that already holds the root lock. */
type StopScope = {
  readonly root: AbsolutePath;
  readonly rootExists: boolean;
  readonly options: StopAppOptions;
  readonly desired: Effect.Effect<ResolvedAppTarget, StopAppError, StopAppServices>;
  /** The cwd command keeps its missing-Landofile error; an explicit root reports unchanged. */
  readonly loadDesiredOnAbsent: boolean;
};

const unchangedResult = (app: string): StopAppResult => ({
  app,
  outcome: "unchanged",
  servicesStopped: [],
});

const withRetirement = (result: StopAppResult, retired: RetirementReceipt | undefined): StopAppResult =>
  retired === undefined
    ? result
    : withShutdownObservations(
        {
          ...result,
          outcome: "stopped" as const,
          servicesStopped: [...new Set([...retired.servicesRemoved, ...result.servicesStopped])],
        },
        retired.shutdownObservations,
        result.shutdownObservations,
      );

type StoppedRuntime = { readonly result: StopAppResult; readonly plan: AppPlan };

/** Shared stop body; callers hold the app mutation lock and decide what happens to routes. */
const stopResolvedRuntime = Effect.fnUntraced(function* (
  options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
  execution: StopExecution,
): Effect.fn.Return<StoppedRuntime, SdkStopAppError, StopAppServices> {
  const registry = yield* RuntimeProviderRegistry;
  const stateStore = yield* StateStore;
  let retired: RetirementReceipt | undefined;
  let validatedTarget = execution.revalidate ? yield* validateResolvedAppTarget(target) : target;
  const placement = yield* resolveAppPlacement(
    execution.reconcileApp ?? validatedTarget.app,
    validatedTarget.plan.provider,
    yield* TeardownProvider,
  );
  if (placement.plan !== undefined) {
    const desired = validatedTarget.plan;
    // An applied record never carries Landofile events. A target resolved from its Landofile
    // keeps that Landofile's steps while the record still describes the same app and provider.
    const events =
      validatedTarget.landofile !== undefined &&
      desired.id === placement.plan.id &&
      desired.provider === placement.plan.provider
        ? desired.events
        : undefined;
    validatedTarget = {
      ...validatedTarget,
      plan: events === undefined ? placement.plan : { ...placement.plan, events },
      root: placement.plan.root,
    };
  }
  const owningProvider = yield* registry.select(validatedTarget.plan);
  yield* registry.assertAppliedStateReadable?.(validatedTarget.plan) ?? Effect.void;
  const pending =
    execution.missingRoot === true ? null : (yield* readDiscardableStart(validatedTarget.app)).pending;
  const runtimeState = (yield* owningProvider.getStatus).state;
  if (runtimeState === "running" && placement.superseded.length > 0) {
    // Preserve cross-provider ambiguity and validate inventories before retirement.
    yield* registry.resolveTeardownEvidence(validatedTarget.root, {
      ...validatedTarget.app,
      id: placement.plan?.id ?? placement.superseded[0]?.id ?? validatedTarget.app.id,
    });
    yield* preflightStopApp(validatedTarget, runtimeState, execution.missingRoot === true);
    retired = yield* retireSupersededRealizations(validatedTarget, placement.superseded, {
      provider: yield* registry.select(placement.plan ?? placement.superseded[0] ?? validatedTarget.plan),
      narration: "teardown",
    });
  }
  const cleanup =
    execution.cleanupOwnership !== false
      ? yield* prepareOwnedResourceCleanup(
          validatedTarget.root,
          {
            volumes: false,
            purgeCaches: false,
          },
          "stop",
        )
      : Effect.succeed({ servicesRemoved: [], networksRemoved: 0, volumesRemoved: { data: 0, cache: 0 } });
  if ((pending === null || pending.phase === "completed") && (execution.requireAppliedEvidence || retired)) {
    const evidence =
      execution.cleanupOwnership === false
        ? yield* registry
            .resolveAppliedPlan(validatedTarget.plan.root, validatedTarget.app, "exact")
            .pipe(
              Effect.map((plan) =>
                plan === undefined ? { kind: "absent" as const } : { kind: "applied" as const, plan },
              ),
            )
        : yield* registry.resolveTeardownEvidence(validatedTarget.plan.root, validatedTarget.app);
    switch (evidence.kind) {
      case "applied":
        break;
      case "orphans":
        return {
          result: withRetirement(
            yield* stopOrphans({
              kind: "orphans",
              root: validatedTarget.root,
              groups: evidence.groups,
              landofilePresent: true,
            }),
            retired,
          ),
          plan: validatedTarget.plan,
        };
      case "owned":
      case "absent": {
        if (runtimeState === "idle")
          yield* stopIdleApp(validatedTarget, yield* preflightStopApp(validatedTarget, runtimeState));
        const removed = yield* cleanup;
        return {
          result: withRetirement(
            {
              app: validatedTarget.plan.name,
              outcome: retired || ownedCleanupChanged(removed) ? "stopped" : "unchanged",
              servicesStopped: removed.servicesRemoved,
              runtimeState,
            },
            retired,
          ),
          plan: validatedTarget.plan,
        };
      }
    }
  }
  const provider = yield* registry.select(validatedTarget.plan);
  const stopped = yield* runtimeState === "idle"
    ? stopAppWithPlanUnlocked(
        options ?? {},
        validatedTarget,
        execution.runInitEvents !== false,
        yield* preflightStopApp(validatedTarget, runtimeState, execution.missingRoot === true),
      )
    : withPlanVolumeCoordination({
        plan: validatedTarget.plan,
        provider,
        stateStore,
        body: Effect.fnUntraced(function* () {
          yield* verifyActiveVolumeCoordination(provider);
          const preflight = yield* preflightStopApp(
            validatedTarget,
            runtimeState,
            execution.missingRoot === true,
          );
          return yield* stopAppWithPlanUnlocked(
            options ?? {},
            validatedTarget,
            execution.runInitEvents !== false,
            preflight,
          );
        }),
      });
  const removed = yield* cleanup;
  return {
    ...stopped,
    result: withRetirement(
      {
        ...stopped.result,
        outcome:
          stopped.result.outcome !== "unchanged" || ownedCleanupChanged(removed)
            ? ("stopped" as const)
            : ("unchanged" as const),
        servicesStopped: [...new Set([...stopped.result.servicesStopped, ...removed.servicesRemoved])],
      },
      retired,
    ),
  };
});

/** Public stop: halts the runtime, then withdraws the owner's published routes under the same lock. */
const stopAppWithResolvedPlan = (
  options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
  execution: StopExecution,
): Effect.Effect<StoppedRuntime, SdkStopAppError, StopAppServices> =>
  withAppMutationLock(
    appLockTarget(target.plan),
    stopResolvedRuntime(options, target, execution).pipe(
      Effect.tap(({ plan }) => withdrawOwnerRoutes(routeOwnerFromPlan(plan))),
    ),
  );

const haltResolvedRuntime = (
  options: StopAppOptions,
  target: ResolvedAppTarget,
  execution: StopExecution,
): Effect.Effect<StoppedRuntime, SdkStopAppError, StopAppServices> =>
  withAppMutationLock(appLockTarget(target.plan), stopResolvedRuntime(options, target, execution));

/**
 * Halts the app runtime for restart and rebuild. Published routes are retained so hostnames keep
 * resolving across the cycle, and owned-resource cleanup is left to the start that follows.
 */
export const haltAppRuntime = Effect.fn("AppOperation.haltRuntime")(function* (
  options: StopAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<
  { readonly result: StopAppResult; readonly plan: AppPlan },
  StopAppError,
  StopAppServices
> {
  return yield* target === undefined
    ? resolveDesiredAppTarget.pipe(
        Effect.flatMap((resolved) =>
          haltResolvedRuntime(options, resolved, {
            revalidate: false,
            requireAppliedEvidence: true,
            runInitEvents: false,
            cleanupOwnership: false,
          }),
        ),
      )
    : haltResolvedRuntime(options, target, {
        revalidate: true,
        requireAppliedEvidence: target.landofile !== undefined,
        runInitEvents: false,
        cleanupOwnership: false,
      });
});

export const stopAppForTarget = Effect.fn("AppOperation.stopForTarget")(function* (
  options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
  afterSuccess?: Effect.Effect<void>,
): Effect.fn.Return<StopAppResult, SdkStopAppError, StopAppServices> {
  return yield* stopAppWithResolvedPlan(options, target, {
    revalidate: true,
    requireAppliedEvidence: target.landofile !== undefined,
  }).pipe(
    Effect.tap(() => afterSuccess ?? Effect.void),
    Effect.map(({ result }) => result),
  );
});

const stopOrphans = (
  resolution: Extract<TeardownResolution, { readonly kind: "orphans" }>,
): Effect.Effect<StopAppResult, SdkStopAppError, StopAppServices> =>
  tearDownOrphans({
    root: resolution.root,
    groups: resolution.groups,
    options: { volumes: false, purgeCaches: false },
  }).pipe(
    Effect.map((removed): StopAppResult => {
      const base: StopAppResult =
        removed.services.length === 0 && !removed.ownedChanged
          ? unchangedResult(removed.app)
          : { app: removed.app, outcome: "stopped", servicesStopped: removed.services };
      return withShutdownObservations(base, removed.shutdownObservations);
    }),
  );

const asStopped = (result: StopAppResult): StopAppResult =>
  result.outcome === "unchanged" ? result : { ...result, outcome: "stopped" };

const journalRef = (root: AbsolutePath, id: string): AppRef => ({
  kind: "user",
  id: AppId.make(id),
  root,
});

const journalPending = Effect.fnUntraced(function* (scope: StopScope, id: string) {
  const { pending } = yield* readDiscardableStart(journalRef(scope.root, id));
  return pending === null || pending.phase === "completed" ? undefined : pending;
});

/**
 * Stop whatever the verified teardown evidence says is still writing at a root whose folder is
 * gone, then clean host workers and withdraw routes. The journal preflight already proved the
 * attempt identity; this never loads desired config or runs live file-sync preflight.
 */
const stopMissingRootWriters = Effect.fnUntraced(function* (
  scope: StopScope,
  pending: NonNullable<Effect.Success<ReturnType<typeof journalPending>>>,
  resolution: TeardownResolution,
): Effect.fn.Return<StopAppResult, StopAppError, StopAppServices> {
  const registry = yield* RuntimeProviderRegistry;
  const app = journalRef(scope.root, pending.appId);
  const services: string[] = [];
  switch (resolution.kind) {
    case "applied": {
      const target = resolution.target;
      const provider = yield* registry.select(target.plan);
      if ((yield* provider.getStatus).state !== "idle") {
        const outcome = yield* provider.destroy(
          { app: target.plan.id, plan: target.plan },
          { volumes: false, removeState: false },
        );
        if (outcome.kind === "destroyed")
          services.push(...Object.values(target.plan.services).reverse().map((service) => String(service.name)));
      }
      const cleanup = yield* prepareOwnedResourceCleanup(
        scope.root,
        { volumes: false, purgeCaches: false },
        "stop",
      );
      services.push(...(yield* cleanup).servicesRemoved);
      break;
    }
    case "orphans": {
      const removed = yield* stopOrphans(resolution);
      services.push(...removed.servicesStopped);
      break;
    }
    case "owned": {
      const removed = yield* tearDownOwnedResources(
        scope.root,
        { volumes: false, purgeCaches: false },
        "stop",
      );
      services.push(...removed.servicesRemoved);
      break;
    }
    case "absent":
      break;
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
  yield* cleanupAppWorkers(app);
  yield* withdrawOwnerRoutes(
    resolution.kind === "applied"
      ? routeOwnerFromPlan(resolution.target.plan)
      : routeOwnerFromRoot(String(app.id), scope.root),
  );
  return {
    app: resolution.kind === "applied" ? resolution.target.plan.name : String(app.id),
    outcome: "stopped",
    servicesStopped: [...new Set(services)],
  };
});

/** Stop a root whose unfinished accelerated start means the desired plan must be the same app. */
const stopRetainedStart = Effect.fnUntraced(function* (
  scope: StopScope,
  pending: NonNullable<Effect.Success<ReturnType<typeof journalPending>>>,
  resolution: TeardownResolution,
  expected?: AppRef,
): Effect.fn.Return<StopAppResult, StopAppError, StopAppServices> {
  if (!scope.rootExists) {
    const app = journalRef(scope.root, pending.appId);
    // Verify the journal and engine identity before any writer is touched.
    const disposal = yield* prepareMissingRootStartDisposal(app, pending, { volumes: false });
    const result = yield* stopMissingRootWriters(scope, pending, resolution);
    // Writers are gone; termination never flushes and the journal stays for the next start.
    yield* disposal.terminate;
    return result;
  }
  const desired = yield* scope.desired;
  if (desired.root !== scope.root) {
    return yield* Effect.fail(
      new FileSyncStopError({
        engineId: pending.engineId,
        sessionRef: pending.appId,
        message: "The desired app root differs from the pending stop target.",
        remediation: "Restore the matching Landofile and run `lando stop` in the recorded app root.",
      }),
    );
  }
  if (expected !== undefined && desired.app.id !== expected.id) {
    return yield* Effect.fail(
      new FileSyncStopError({
        engineId: pending.engineId,
        sessionRef: pending.appId,
        message: "The desired app identity differs from pending applied runtime state.",
        remediation: "Restore the matching Landofile and retry `lando stop` in the recorded app root.",
      }),
    );
  }
  return (yield* stopAppWithResolvedPlan(scope.options, desired, {
    revalidate: false,
    requireAppliedEvidence: false,
  })).result;
});

/** One stop body for every teardown evidence kind; entry points supply the root and desired loader. */
const stopResolution = (
  scope: StopScope,
  resolution: TeardownResolution,
): Effect.Effect<StopAppResult, StopAppError, StopAppServices> => {
  const body = Effect.gen(function* () {
    switch (resolution.kind) {
      case "applied": {
        const target = resolution.target;
        const pending = yield* journalPending(scope, String(target.app.id));
        if (pending !== undefined) return yield* stopRetainedStart(scope, pending, resolution, target.app);
        return (yield* stopAppWithResolvedPlan(scope.options, target, {
          revalidate: false,
          requireAppliedEvidence: false,
          missingRoot: !scope.rootExists,
          ...(resolution.reconcileApp === undefined ? {} : { reconcileApp: resolution.reconcileApp }),
        })).result;
      }
      case "orphans": {
        const app = resolution.groups[0]?.appId ?? scope.root;
        const pending = yield* journalPending(scope, String(app));
        if (pending !== undefined) return yield* stopRetainedStart(scope, pending, resolution);
        const result = yield* stopOrphans(resolution);
        yield* withdrawOwnerRoutes(routeOwnerFromRoot(result.app, scope.root));
        return result;
      }
      case "owned": {
        const app = resolution.ownership[0]?.appIds[0] ?? basename(scope.root);
        const pending = yield* journalPending(scope, String(app));
        if (pending !== undefined) return yield* stopRetainedStart(scope, pending, resolution);
        const removed = yield* tearDownOwnedResources(
          scope.root,
          { volumes: false, purgeCaches: false },
          "stop",
        );
        yield* withdrawOwnerRoutes(routeOwnerFromRoot(String(app), scope.root));
        return {
          app: String(app),
          outcome: ownedCleanupChanged(removed) ? ("stopped" as const) : ("unchanged" as const),
          servicesStopped: removed.servicesRemoved,
        } satisfies StopAppResult;
      }
      case "absent": {
        const app = basename(scope.root);
        // A root with an unfinished start is never reported unchanged, and its journal is read
        // before this result is decided.
        const pending = yield* journalPending(scope, app);
        if (pending !== undefined) return yield* stopRetainedStart(scope, pending, resolution);
        if (!scope.loadDesiredOnAbsent) return unchangedResult(app);
        return yield* teardownDesiredOrUnchanged(
          resolution,
          (desired) =>
            stopAppWithResolvedPlan(scope.options, desired, {
              revalidate: false,
              requireAppliedEvidence: true,
            }).pipe(Effect.map(({ result }) => result)),
          unchangedResult,
          scope.desired,
        );
      }
      default: {
        const unreachable: never = resolution;
        return unreachable;
      }
    }
  });
  return body.pipe(Effect.map(asStopped));
};

const canonicalStopRoot = (root: string) => {
  const requested = AbsolutePath.make(resolvePath(root));
  return canonicalMissingAppRoot(root).pipe(
    Effect.map((canonical) => AbsolutePath.make(canonical)),
    Effect.catchTag("StateStoreError", (cause) =>
      Effect.fail(
        new AppResolveError({
          reason: "missing-root",
          detail: "unresolvable-root",
          message: `The app folder path ${requested} cannot be resolved.`,
          remediation: isErrnoCode(cause.cause, "ENOENT")
            ? `Part of ${requested} is a symlink whose target no longer exists. Remove or fix that symlink, then rerun lando stop --root ${shellArg(requested)}.`
            : `Check that you can read every folder in ${requested}, then rerun.`,
          cause,
        }),
      ),
    ),
  );
};

const appRootExists = (root: AbsolutePath): Effect.Effect<boolean, AppResolveError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await stat(root);
        return true;
      } catch (cause) {
        if (isErrnoCode(cause, "ENOENT")) return false;
        throw cause;
      }
    },
    catch: (cause) =>
      new AppResolveError({
        reason: "missing-root",
        detail: "unreadable-root",
        message: `The app folder ${root} cannot be inspected.`,
        remediation: `Check that you can read ${root} and its parent folders, then retry.`,
        cause,
      }),
  });

const stopAtRoot = Effect.fnUntraced(function* (
  requested: string,
  options: StopAppOptions,
  mode: "cwd" | "root",
) {
  const root = yield* canonicalStopRoot(requested);
  return yield* withAppMutationLock(
    { kind: "user", id: root, root },
    Effect.gen(function* () {
      const rootExists = yield* appRootExists(root);
      const present = yield* landofilePresentAt(root);
      // Both authored forms present is still a Landofile at this root; the loader decides.
      const landofilePresent = Result.isSuccess(present) ? present.success : true;
      const targetFor = rootExists
        ? appliedStateTarget
        : (plan: AppPlan) => missingRootAppliedTarget(plan, root);
      const resolution = yield* teardownResolutionAtRoot(root, landofilePresent, targetFor);
      return yield* stopResolution(
        {
          root,
          rootExists,
          options,
          desired: mode === "cwd" ? resolveDesiredAppTarget : resolveDesiredAppTargetAtRoot(root),
          loadDesiredOnAbsent: mode === "cwd",
        },
        resolution,
      );
    }),
  );
});

export const stopApp = Effect.fn("AppOperation.stop")(function* (
  options: StopAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<StopAppResult, StopAppError, StopAppServices> {
  if (target !== undefined) return yield* stopAppForTarget(options, target);
  const discovered = yield* findAppRoot();
  return yield* stopAtRoot(discovered ?? (yield* discoveryCwd()), options, "cwd");
});

/**
 * Stop the app recorded at one canonical root. The root lock is acquired before any provider
 * evidence is read, so a concurrent start or stop at the same root cannot invalidate the evidence
 * between resolution and mutation. `providerId` restricts every evidence read to that provider.
 */
export const stopAppAtRoot = Effect.fn("AppOperation.stopAtRoot")(function* (
  root: string,
  options: StopAppAtRootOptions = {},
): Effect.fn.Return<StopAppResult, StopAppError, StopAppServices> {
  const { providerId, ...stopOptions } = options;
  const effect = stopAtRoot(root, stopOptions, "root");
  return yield* providerId === undefined
    ? effect
    : effect.pipe(Effect.provideService(TeardownProvider, providerId));
});
