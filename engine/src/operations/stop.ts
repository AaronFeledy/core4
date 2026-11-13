import { basename } from "node:path";
import type { StopAppError as SdkStopAppError, StopAppOptions, StopAppResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  FileSyncStopError,
  type LandofileLoadExpressionError,
} from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
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
import { Effect } from "effect";

import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { routeOwnerFromPlan, routeOwnerFromRoot } from "../lifecycle/route-owner.ts";
import { withdrawOwnerRoutes } from "../lifecycle/route-withdrawal.ts";
import {
  verifyActiveVolumeCoordination,
  withPlanVolumeCoordination,
} from "../lifecycle/volume-coordination.ts";
import { TeardownProvider, resolveAppPlacement } from "../providers/app-placement.ts";
import { readDiscardableStart } from "./accelerated-start-disposal.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  teardownDesiredOrUnchanged,
  validateResolvedAppTarget,
  withTeardownResolution,
} from "./applied-state-target.ts";
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
  const { pending } = yield* readDiscardableStart(validatedTarget.app);
  const runtimeState = (yield* owningProvider.getStatus).state;
  if (runtimeState === "running" && placement.superseded.length > 0) {
    // Preserve cross-provider ambiguity and validate inventories before retirement.
    yield* registry.resolveTeardownEvidence(validatedTarget.root, {
      ...validatedTarget.app,
      id: placement.plan?.id ?? placement.superseded[0]?.id ?? validatedTarget.app.id,
    });
    yield* preflightStopApp(validatedTarget, runtimeState);
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
      : Effect.succeed({ servicesRemoved: [], networksRemoved: 0, volumesRemoved: 0 });
  if ((pending === null || pending.phase === "completed") && (execution.requireAppliedEvidence || retired)) {
    const evidence =
      execution.cleanupOwnership === false
        ? yield* registry
            .resolveAppliedPlan(validatedTarget.plan.root, validatedTarget.app)
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
        yield* preflightStopApp(validatedTarget, runtimeState),
      )
    : withPlanVolumeCoordination({
        plan: validatedTarget.plan,
        provider,
        stateStore,
        body: Effect.fnUntraced(function* () {
          yield* verifyActiveVolumeCoordination(provider);
          const preflight = yield* preflightStopApp(validatedTarget, runtimeState);
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
  execution: { readonly skipInitEvents?: boolean } = {},
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
            runInitEvents: execution.skipInitEvents !== true,
            cleanupOwnership: false,
          }),
        ),
      )
    : haltResolvedRuntime(options, target, {
        revalidate: true,
        requireAppliedEvidence: target.landofile !== undefined,
        runInitEvents: execution.skipInitEvents !== true,
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

const stopDesiredOrUnchanged = (
  options: StopAppOptions,
  resolution: Extract<TeardownResolution, { readonly kind: "absent" }>,
): Effect.Effect<StopAppResult, StopAppError, StopAppServices> =>
  teardownDesiredOrUnchanged(
    resolution,
    (desired) =>
      stopAppWithResolvedPlan(options, desired, {
        revalidate: false,
        requireAppliedEvidence: true,
      }).pipe(Effect.map(({ result }) => result)),
    unchangedResult,
  );

export const stopApp = Effect.fn("AppOperation.stop")(function* (
  options: StopAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<StopAppResult, StopAppError, StopAppServices> {
  return yield* target !== undefined
    ? stopAppForTarget(options, target)
    : withTeardownResolution({
        owned: Effect.fnUntraced(function* (resolution) {
          const { pending } = yield* readDiscardableStart({
            kind: "user",
            id: resolution.ownership[0]?.appIds[0] ?? "unknown",
            root: resolution.root,
          });
          if (pending !== null && pending.phase !== "completed") {
            const desired = yield* resolveDesiredAppTarget;
            if (desired.root !== resolution.root)
              return yield* Effect.fail(
                new FileSyncStopError({
                  engineId: pending.engineId,
                  sessionRef: pending.appId,
                  message: "The desired app root differs from the pending stop target.",
                  remediation:
                    "Restore the matching Landofile and run `lando stop` in the recorded app root.",
                }),
              );
            return (yield* stopAppWithResolvedPlan(options, desired, {
              revalidate: false,
              requireAppliedEvidence: false,
            })).result;
          }
          const app = resolution.ownership[0]?.appIds[0] ?? resolution.root;
          return yield* withAppMutationLock(
            { id: resolution.ownership[0]?.appIds[0] ?? basename(resolution.root), root: resolution.root },
            tearDownOwnedResources(resolution.root, { volumes: false, purgeCaches: false }, "stop").pipe(
              Effect.map(
                (removed): StopAppResult => ({
                  app,
                  outcome: ownedCleanupChanged(removed) ? "stopped" : "unchanged",
                  servicesStopped: removed.servicesRemoved,
                }),
              ),
              Effect.tap(() => withdrawOwnerRoutes(routeOwnerFromRoot(app, resolution.root))),
            ),
          );
        }),
        applied: Effect.fnUntraced(function* (resolved, reconcileApp?: AppRef) {
          const { pending } = yield* readDiscardableStart(resolved.app);
          if (pending !== null && pending.phase !== "completed") {
            const desired = yield* resolveDesiredAppTarget;
            if (desired.root !== resolved.root || desired.app.id !== resolved.app.id)
              return yield* Effect.fail(
                new FileSyncStopError({
                  engineId: pending.engineId,
                  sessionRef: pending.appId,
                  message: "The desired app identity differs from pending applied runtime state.",
                  remediation:
                    "Restore the matching Landofile and retry `lando stop` in the recorded app root.",
                }),
              );
            return (yield* stopAppWithResolvedPlan(options, desired, {
              revalidate: false,
              requireAppliedEvidence: false,
            })).result;
          }
          return yield* stopAppWithResolvedPlan(options, resolved, {
            revalidate: false,
            requireAppliedEvidence: false,
            ...(reconcileApp === undefined ? {} : { reconcileApp }),
          }).pipe(Effect.map(({ result }) => result));
        }),
        orphans: Effect.fnUntraced(function* (resolution) {
          const first = resolution.groups[0];
          const { pending } = yield* readDiscardableStart({
            kind: "user",
            id: first?.appId ?? "unknown",
            root: resolution.root,
          });
          if (pending !== null && pending.phase !== "completed") {
            const desired = yield* resolveDesiredAppTarget;
            if (desired.root !== resolution.root)
              return yield* Effect.fail(
                new FileSyncStopError({
                  engineId: pending.engineId,
                  sessionRef: pending.appId,
                  message: "The desired app root differs from the pending stop target.",
                  remediation:
                    "Restore the matching Landofile and run `lando stop` in the recorded app root.",
                }),
              );
            return (yield* stopAppWithResolvedPlan(options, desired, {
              revalidate: false,
              requireAppliedEvidence: false,
            })).result;
          }
          return yield* withAppMutationLock(
            { id: first?.appId ?? resolution.root, root: resolution.root },
            stopOrphans(resolution).pipe(
              Effect.tap((result) => withdrawOwnerRoutes(routeOwnerFromRoot(result.app, resolution.root))),
            ),
          );
        }),
        absent: (resolution) => stopDesiredOrUnchanged(options, resolution),
      }).pipe(
        Effect.map(
          (result): StopAppResult =>
            result.outcome === "unchanged" ? result : { ...result, outcome: "stopped" },
        ),
      );
});
