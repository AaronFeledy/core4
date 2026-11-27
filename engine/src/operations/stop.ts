import { basename } from "node:path";
import { findAppRoot } from "@lando/landofile/discovery";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import type { StopAppError as SdkStopAppError, StopAppOptions, StopAppResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  FileSyncStopError,
  type LandofileLoadExpressionError,
} from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan, AppRef, ProviderId } from "@lando/sdk/schema";
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
import { validateRequested } from "./service-selection.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";
import { stopIdleApp } from "./stop-idle.ts";
import { preflightStopApp, stopAppWithPlanUnlocked } from "./stop-internal.ts";
import { journalPending, stopMissingRootStart } from "./stop-missing-root.ts";
import { type StoppedRealizations, stopOrphans, stopSupersededRealizations } from "./stop-realizations.ts";
import { withContainerReceipts } from "./stop-receipts.ts";
import { appRootExists, canonicalStopRoot } from "./stop-root.ts";
import { requestedStopServices, selectedStopRefusal, stopSelectedAppServices } from "./stop-selection.ts";

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
  /** `applied` reads only this app's applied record; `teardown` also accepts orphan and inventory evidence. */
  readonly evidence?: "applied" | "teardown";
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

const withSuperseded = (result: StopAppResult, superseded: StoppedRealizations | undefined): StopAppResult =>
  superseded === undefined
    ? result
    : withShutdownObservations(
        withContainerReceipts(
          {
            ...result,
            outcome:
              result.outcome === "unchanged" && superseded.servicesStopped.length === 0
                ? ("unchanged" as const)
                : ("stopped" as const),
            servicesStopped: [...new Set([...superseded.servicesStopped, ...result.servicesStopped])],
          },
          superseded.containers,
          result.containers,
        ),
        superseded.shutdownObservations,
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
  let superseded: StoppedRealizations | undefined;
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
  yield* registry.readAppliedPlanStrict(validatedTarget.plan);
  const owningProvider = yield* registry.select(validatedTarget.plan);
  const selected = requestedStopServices(options);
  if (selected !== undefined) {
    const services = yield* validateRequested(validatedTarget.plan, selected);
    const refusal = selectedStopRefusal({
      journal: pending !== null && pending.phase !== "completed" ? pending : undefined,
      rootExists: execution.missingRoot !== true,
      record: placement.plan === undefined ? "none" : "applied",
    });
    if (refusal !== undefined) return yield* Effect.fail(refusal);
    return {
      result: yield* stopSelectedAppServices(services, validatedTarget, placement.plan !== undefined),
      plan: validatedTarget.plan,
    };
  }
  const runtimeState = (yield* owningProvider.getStatus).state;
  if (runtimeState === "running" && placement.superseded.length > 0) {
    // Preserve cross-provider ambiguity and validate inventories before stopping earlier names.
    yield* registry.resolveTeardownEvidence(validatedTarget.root, {
      ...validatedTarget.app,
      id: placement.plan?.id ?? placement.superseded[0]?.id ?? validatedTarget.app.id,
    });
    yield* preflightStopApp(validatedTarget, runtimeState, execution.missingRoot === true);
    superseded = yield* stopSupersededRealizations(
      placement.superseded,
      yield* registry.select(placement.plan ?? placement.superseded[0] ?? validatedTarget.plan),
    );
    // The kept earlier names stay applied until the next start or destroy retires them, and
    // without a realization under the current name nothing else runs at this root.
    if (placement.plan === undefined)
      return {
        result: withSuperseded(
          { app: validatedTarget.plan.name, outcome: "unchanged", servicesStopped: [], runtimeState },
          superseded,
        ),
        plan: validatedTarget.plan,
      };
  }
  if (
    (pending === null || pending.phase === "completed") &&
    (execution.requireAppliedEvidence || superseded !== undefined)
  ) {
    const evidence =
      execution.evidence === "applied"
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
          result: withSuperseded(
            yield* stopOrphans({ root: validatedTarget.root, groups: evidence.groups }),
            superseded,
          ),
          plan: validatedTarget.plan,
        };
      // An ownership inventory with no observed container has nothing left to stop.
      case "owned":
      case "absent": {
        if (runtimeState === "idle")
          yield* stopIdleApp(validatedTarget, yield* preflightStopApp(validatedTarget, runtimeState));
        return {
          result: withSuperseded(
            { app: validatedTarget.plan.name, outcome: "unchanged", servicesStopped: [], runtimeState },
            superseded,
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
  return { ...stopped, result: withSuperseded(stopped.result, superseded) };
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
  target: ResolvedAppTarget,
  execution: StopExecution,
): Effect.Effect<StoppedRuntime, SdkStopAppError, StopAppServices> =>
  withAppMutationLock(appLockTarget(target.plan), stopResolvedRuntime({}, target, execution));

/**
 * Halts the app runtime for restart and rebuild. Containers are stopped and kept, and published
 * routes are retained so hostnames keep resolving across the cycle; the start that follows reuses
 * or replaces each container and removes those of services the Landofile no longer defines.
 */
export const haltAppRuntime = Effect.fn("AppOperation.haltRuntime")(function* (
  target?: ResolvedAppTarget,
): Effect.fn.Return<
  { readonly result: StopAppResult; readonly plan: AppPlan },
  StopAppError,
  StopAppServices
> {
  return yield* target === undefined
    ? resolveDesiredAppTarget.pipe(
        Effect.flatMap((resolved) =>
          haltResolvedRuntime(resolved, {
            revalidate: false,
            requireAppliedEvidence: true,
            runInitEvents: false,
            evidence: "applied",
          }),
        ),
      )
    : haltResolvedRuntime(target, {
        revalidate: true,
        requireAppliedEvidence: target.landofile !== undefined,
        runInitEvents: false,
        evidence: "applied",
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

/** The app id a root's journal and route owner use, from the strongest evidence at that root. */
const resolutionAppId = (root: AbsolutePath, resolution: TeardownResolution): string => {
  switch (resolution.kind) {
    case "applied":
      return String(resolution.target.app.id);
    case "orphans":
      return String(resolution.groups[0]?.appId ?? root);
    case "owned":
      return String(resolution.ownership[0]?.appIds[0] ?? basename(root));
    case "absent":
      return basename(root);
    default:
      return resolution satisfies never;
  }
};

const stopResolution = (
  scope: StopScope,
  evidence: TeardownResolution,
): Effect.Effect<StopAppResult, StopAppError, StopAppServices> => {
  const body = Effect.gen(function* () {
    const app = resolutionAppId(scope.root, evidence);
    const pending = yield* journalPending(scope.root, app);
    const selected = requestedStopServices(scope.options) !== undefined;
    // Without an applied plan only observed containers can still run, so a selected stop treats
    // retained volumes and ownership records like an app that never started.
    const unrecorded =
      evidence.kind === "orphans" && evidence.groups.some((group) => group.services.length > 0);
    if (selected) {
      const refusal = selectedStopRefusal({
        journal: pending,
        rootExists: scope.rootExists,
        record: evidence.kind === "applied" ? "applied" : unrecorded ? "unrecorded" : "none",
      });
      if (refusal !== undefined) return yield* Effect.fail(refusal);
    }
    const resolution: TeardownResolution =
      selected && evidence.kind !== "applied"
        ? { kind: "absent", root: evidence.root, landofilePresent: evidence.landofilePresent }
        : evidence;
    switch (resolution.kind) {
      case "applied": {
        const target = resolution.target;
        if (pending !== undefined) return yield* stopRetainedStart(scope, pending, resolution);
        return (yield* stopAppWithResolvedPlan(scope.options, target, {
          revalidate: false,
          requireAppliedEvidence: false,
          missingRoot: !scope.rootExists,
          ...(resolution.reconcileApp === undefined ? {} : { reconcileApp: resolution.reconcileApp }),
        })).result;
      }
      case "orphans": {
        if (pending !== undefined) return yield* stopRetainedStart(scope, pending, resolution);
        const result = yield* stopOrphans(resolution);
        yield* withdrawOwnerRoutes(routeOwnerFromRoot(result.app, scope.root));
        return result;
      }
      // An ownership inventory with no observed container has nothing left to stop.
      case "owned": {
        if (pending !== undefined) return yield* stopRetainedStart(scope, pending, resolution);
        yield* withdrawOwnerRoutes(routeOwnerFromRoot(app, scope.root));
        return unchangedResult(app);
      }
      case "absent": {
        if (pending !== undefined) return yield* stopRetainedStart(scope, pending, resolution);
        if (!scope.loadDesiredOnAbsent)
          return selected ? { ...unchangedResult(app), servicesKeptRunning: [] } : unchangedResult(app);
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
