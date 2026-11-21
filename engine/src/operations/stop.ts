import { basename } from "node:path";
import { findAppRoot } from "@lando/landofile/discovery";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import type { StopAppError as SdkStopAppError, StopAppOptions, StopAppResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  FileSyncStopError,
  type LandofileLoadExpressionError,
} from "@lando/sdk/errors";
import {
  type AbsolutePath,
  type AppPlan,
  type AppRef,
  type ProviderId,
  noVolumesRemoved,
} from "@lando/sdk/schema";
import {
  type AppPlanner,
  type EventService,
  type FileSystem,
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
import { type PendingStart, recordedStartCommand } from "./accelerated-start-record.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  appliedStateTarget,
  missingRootAppliedTarget,
  teardownDesiredOrUnchanged,
  teardownResolutionAtRoot,
  validateResolvedAppTarget,
} from "./applied-state-target.ts";
import { landofilePresentAt } from "./landofile-events.ts";
import {
  ownedCleanupChanged,
  prepareOwnedResourceCleanup,
  tearDownOwnedResources,
} from "./owned-resource-teardown.ts";
import { validateRequested } from "./service-selection.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";
import { stopIdleApp } from "./stop-idle.ts";
import { preflightStopApp, stopAppWithPlanUnlocked } from "./stop-internal.ts";
import { journalPending, stopMissingRootStart, stopOrphans } from "./stop-missing-root.ts";
import { appRootExists, canonicalStopRoot } from "./stop-root.ts";
import {
  rejectSelectedStopWithoutApplied,
  requestedStopServices,
  stopSelectedAppServices,
} from "./stop-selection.ts";
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

type StopScope = {
  readonly root: AbsolutePath;
  readonly rootExists: boolean;
  readonly retryCommand: string;
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

const validateStopSelection = Effect.fnUntraced(function* (
  target: ResolvedAppTarget,
  selected: NonNullable<ReturnType<typeof requestedStopServices>>,
  execution: StopExecution,
  pending: PendingStart | null,
) {
  yield* validateRequested(target.plan, selected);
  if (execution.missingRoot === true) return yield* rejectSelectedStopWithoutApplied();
  if (pending === null || pending.phase === "completed") return;
  return yield* Effect.fail(
    new FileSyncStopError({
      engineId: pending.engineId,
      sessionRef: String(target.app.id),
      message: "Selected stop cannot run while an accelerated start is unfinished.",
      remediation: `Run \`${recordedStartCommand(pending)}\` to finish the attempt, or \`lando stop\` without --service.`,
    }),
  );
});

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
  const pending =
    execution.missingRoot === true ? null : (yield* readDiscardableStart(validatedTarget.app)).pending;
  if (placement.plan !== undefined && (pending === null || pending.phase === "completed")) {
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
  const selected = requestedStopServices(options);
  if (selected !== undefined) {
    yield* validateStopSelection(validatedTarget, selected, execution, pending);
    return {
      result: yield* stopSelectedAppServices(selected, validatedTarget),
      plan: validatedTarget.plan,
    };
  }
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
      : Effect.succeed({ servicesRemoved: [], networksRemoved: 0, volumesRemoved: { ...noVolumesRemoved } });
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
        additionalPlans: placement.plan === undefined ? [] : [placement.plan],
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
      Effect.tap(({ plan }) =>
        requestedStopServices(options) === undefined
          ? withdrawOwnerRoutes(routeOwnerFromPlan(plan))
          : Effect.void,
      ),
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
  const { services: _services, ...haltOptions } = options;
  return yield* target === undefined
    ? resolveDesiredAppTarget.pipe(
        Effect.flatMap((resolved) =>
          haltResolvedRuntime(haltOptions, resolved, {
            revalidate: false,
            requireAppliedEvidence: true,
            runInitEvents: false,
            cleanupOwnership: false,
          }),
        ),
      )
    : haltResolvedRuntime(haltOptions, target, {
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

/** Stop a root whose unfinished accelerated start means the desired plan must be the same app. */
const stopRetainedStart = Effect.fnUntraced(function* (
  scope: StopScope,
  pending: NonNullable<Effect.Success<ReturnType<typeof journalPending>>>,
  resolution: TeardownResolution,
): Effect.fn.Return<StopAppResult, StopAppError, StopAppServices> {
  if (!scope.rootExists) return yield* stopMissingRootStart(scope, pending, resolution);
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
  if (resolution.kind === "applied" && desired.app.id !== resolution.target.app.id) {
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

const stopResolution = (
  scope: StopScope,
  resolution: TeardownResolution,
): Effect.Effect<StopAppResult, StopAppError, StopAppServices> => {
  const body = Effect.gen(function* () {
    switch (resolution.kind) {
      case "applied": {
        const target = resolution.target;
        const pending = yield* journalPending(scope.root, String(target.app.id));
        if (pending !== undefined) return yield* stopRetainedStart(scope, pending, resolution);
        return (yield* stopAppWithResolvedPlan(scope.options, target, {
          revalidate: false,
          requireAppliedEvidence: false,
          missingRoot: !scope.rootExists,
          ...(resolution.reconcileApp === undefined ? {} : { reconcileApp: resolution.reconcileApp }),
        })).result;
      }
      case "orphans": {
        if (requestedStopServices(scope.options) !== undefined)
          return yield* rejectSelectedStopWithoutApplied();
        const app = resolution.groups[0]?.appId ?? scope.root;
        const pending = yield* journalPending(scope.root, String(app));
        if (pending !== undefined) return yield* stopRetainedStart(scope, pending, resolution);
        const result = yield* stopOrphans(resolution);
        yield* withdrawOwnerRoutes(routeOwnerFromRoot(result.app, scope.root));
        return result;
      }
      case "owned": {
        if (requestedStopServices(scope.options) !== undefined)
          return yield* rejectSelectedStopWithoutApplied();
        const app = resolution.ownership[0]?.appIds[0] ?? basename(scope.root);
        const pending = yield* journalPending(scope.root, String(app));
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
        const pending = yield* journalPending(scope.root, app);
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
  return body.pipe(
    Effect.map(
      (result): StopAppResult =>
        result.outcome === "unchanged" ? result : { ...result, outcome: "stopped" },
    ),
  );
};

const stopAtRoot = Effect.fnUntraced(function* <E, R>(
  requested: string,
  options: StopAppOptions,
  mode: "cwd" | "root" | "poweroff",
  rootExistsAt: (root: AbsolutePath) => Effect.Effect<boolean, E, R>,
) {
  const root = yield* canonicalStopRoot(requested);
  return yield* withAppMutationLock(
    { kind: "user", id: root, root },
    Effect.gen(function* () {
      const rootExists = yield* rootExistsAt(root);
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
          retryCommand: mode === "poweroff" ? "lando poweroff" : `lando stop --root ${shellArg(root)}`,
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
  // A discovered root, or the working directory, exists by construction.
  return yield* stopAtRoot(discovered ?? (yield* discoveryCwd()), options, "cwd", () => Effect.succeed(true));
});

/**
 * Stop the app recorded at one canonical root. The root lock is acquired before any provider
 * evidence is read, so a concurrent start or stop at the same root cannot invalidate the evidence
 * between resolution and mutation. `providerId` restricts every evidence read to that provider.
 */
export const stopAppAtRoot = Effect.fn("AppOperation.stopAtRoot")(function* (
  root: string,
  options: StopAppAtRootOptions = {},
  mode: "root" | "poweroff" = "root",
): Effect.fn.Return<StopAppResult, StopAppError, StopAppServices | FileSystem> {
  const { providerId, ...stopOptions } = options;
  const effect = stopAtRoot(root, stopOptions, mode, appRootExists);
  return yield* providerId === undefined
    ? effect
    : effect.pipe(Effect.provideService(TeardownProvider, providerId));
});
