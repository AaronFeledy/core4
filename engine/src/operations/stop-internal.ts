import { mergeAppliedPlan } from "@lando/container-runtime/plan";
import type { StopAppError as SdkStopAppError, StopAppResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  FileSyncStopError,
  type LandofileLoadExpressionError,
} from "@lando/sdk/errors";
import {
  PostAppStopEvent,
  PostServiceStopEvent,
  PostStopEvent,
  PreAppStopEvent,
  PreServiceStopEvent,
  PreStopEvent,
} from "@lando/sdk/events";
import type {
  AppPlan,
  ContainerBringDownReceipt,
  FileSyncSessionInfo,
  ServiceShutdownObservation,
} from "@lando/sdk/schema";
import {
  type AppPlanner,
  type AppliedFileSyncInspection,
  EventService,
  FileSyncEngine,
  type FileSyncEngineShape,
  type LandofileService,
  type PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Option } from "effect";

import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";

import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { acceleratedStartStopError } from "./accelerated-start-disposal.ts";
import { resolvePendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { recordedSessionInventory } from "./accelerated-start-resume.ts";
import { cleanupAppWorkers } from "./destroy-provider.ts";
import { publishAndRunAppEvent, publishAndRunPostAppEvent, runAppInitEvents } from "./events.ts";
import { hasStopFileSyncCoverage, terminateFileSyncSessions } from "./file-sync.ts";
import { acquireFileSyncEngine } from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { resolveLandofileEventPlan } from "./landofile-events.ts";
import { mergeShutdownObservations } from "./shutdown-observations.ts";
import { idleStopEventPlan, stopIdleApp } from "./stop-idle.ts";
import { mergeContainerReceipts, servicesTakenDown } from "./stop-receipts.ts";
import { absentPlannedServices } from "./stop-selection.ts";
import { stopUnplannedContainers } from "./stop-unplanned.ts";
import { markUpgradeTeardown } from "./upgrade-teardown-boundary.ts";

export type StopAppError = SdkStopAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { StopAppOptions, StopAppResult } from "@lando/sdk/app";

type StopAppServices =
  | AppPlanner
  | EventService
  | LandofileService
  | PathsService
  | PrivateFileAccessService
  | RuntimeProviderRegistry
  | StateStore;

const now = () => DateTime.nowUnsafe();

export interface StopAppPreflight {
  readonly runtimeState: "running" | "idle";
  readonly provider: RuntimeProviderShape;
  readonly appliedFileSync: AppliedFileSyncInspection;
  readonly maybeFileSync: Option.Option<FileSyncEngineShape>;
  readonly fileSyncAvailable: boolean;
  readonly sessions: ReadonlyArray<FileSyncSessionInfo>;
  readonly absentServices: ReadonlySet<string>;
  readonly retainedWriters?: AppPlan;
  /**
   * With an unfinished start, the journal is judged against the desired plan, but applied
   * services the desired plan no longer names may still run, so teardown covers both.
   */
  readonly teardownPlan?: AppPlan;
}

/** Verify the provider's saved mount state before any app hook or writer shutdown. */
export const preflightStopApp = Effect.fnUntraced(function* (
  target: ResolvedAppTarget,
  observedState?: StopAppPreflight["runtimeState"],
  missingRoot = false,
): Effect.fn.Return<StopAppPreflight, SdkStopAppError, RuntimeProviderRegistry | StateStore> {
  const pending = missingRoot
    ? null
    : yield* resolvePendingAcceleratedStart(target.app, target.plan).pipe(
        mapFailureErrors((cause) => acceleratedStartStopError(target.app, cause)),
      );
  const registry = yield* RuntimeProviderRegistry;
  const plan = target.plan;
  const provider = yield* registry.select(plan);
  const runtimeState = observedState ?? (yield* provider.getStatus).state;
  if (pending !== null) {
    const applied = yield* registry.resolveAppliedPlan(
      plan.identity?.appRoot ?? plan.root,
      target.app,
      "exact",
    );
    const savedBundle =
      applied === undefined
        ? undefined
        : yield* fileSyncBundle(applied).pipe(
            mapFailureErrors((cause) => acceleratedStartStopError(target.app, cause)),
          );
    const prior =
      runtimeState === "idle"
        ? savedBundle?.kind === "accelerated"
          ? { status: "accelerated" as const, engineId: savedBundle.id, sessions: savedBundle.sessions }
          : undefined
        : yield* provider.inspectAppliedFileSync?.(plan) ?? Effect.succeed(undefined);
    const inventory = yield* recordedSessionInventory(target.app, pending, { prior }).pipe(
      mapFailureErrors((cause) => acceleratedStartStopError(target.app, cause)),
    );
    const retainedWriters =
      applied !== undefined && pending.record.services !== undefined && runtimeState === "running"
        ? mergeAppliedPlan(applied, pending.plan)
        : undefined;
    return {
      runtimeState,
      provider,
      appliedFileSync: {
        status: "accelerated",
        engineId: pending.record.engineId,
        sessions: [...inventory.applied, ...inventory.pending],
      },
      maybeFileSync: Option.some(inventory.engine),
      fileSyncAvailable: true,
      sessions: inventory.sessions,
      absentServices: new Set(),
      ...(retainedWriters === undefined ? {} : { retainedWriters }),
      ...(applied === undefined ? {} : { teardownPlan: mergeAppliedPlan(applied, plan) }),
    };
  }
  const ref = target.app;
  const bundle =
    provider.inspectAppliedFileSync === undefined || runtimeState === "idle"
      ? yield* fileSyncBundle(plan).pipe(
          mapFailureErrors((cause) => acceleratedStartStopError(target.app, cause)),
        )
      : undefined;
  const appliedFileSync =
    provider.inspectAppliedFileSync === undefined
      ? {
          status:
            bundle?.kind === "accelerated" && provider.prepareFileSyncTargets !== undefined
              ? ("unknown" as const)
              : ("ordinary" as const),
        }
      : yield* provider.inspectAppliedFileSync(plan);
  const engineId =
    appliedFileSync.status === "accelerated"
      ? appliedFileSync.engineId
      : runtimeState === "idle" && bundle?.kind === "accelerated"
        ? bundle.id
        : undefined;
  const maybeFileSync =
    engineId !== undefined
      ? yield* acquireFileSyncEngine(engineId).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none())),
        )
      : Option.none();
  const fileSyncAvailable = Option.isSome(maybeFileSync) && (yield* maybeFileSync.value.isAvailable);
  const sessions =
    fileSyncAvailable && Option.isSome(maybeFileSync)
      ? yield* maybeFileSync.value.listSessions({ app: ref })
      : [];
  const absentServices =
    runtimeState !== "idle" && appliedFileSync.status === "accelerated"
      ? absentPlannedServices(plan, yield* provider.list({ app: plan.id, includeUnplanned: true }))
      : new Set<string>();
  // An idle runtime runs no writer and idle stop flushes and removes nothing, so the
  // proof that guards writer shutdown does not apply; providers may not observe volumes then.
  if (
    runtimeState !== "idle" &&
    (appliedFileSync.status === "unknown" ||
      (appliedFileSync.status === "accelerated" &&
        (Option.isNone(maybeFileSync) ||
          maybeFileSync.value.id !== appliedFileSync.engineId ||
          !hasStopFileSyncCoverage(appliedFileSync.sessions, sessions, absentServices))))
  ) {
    return yield* Effect.fail(
      new FileSyncStopError({
        engineId:
          appliedFileSync.status === "accelerated"
            ? appliedFileSync.engineId
            : Option.isSome(maybeFileSync)
              ? maybeFileSync.value.id
              : "unavailable",
        sessionRef: String(sessions[0]?.ref ?? plan.id),
        message:
          appliedFileSync.status === "unknown"
            ? "Previous file sync state could not be verified; stopping may leave unsynchronized changes."
            : "An accelerated mount has no matching active file sync session.",
        remediation: "Inspect and repair the file sync session and provider state, then retry stop.",
      }),
    );
  }

  return {
    runtimeState,
    provider,
    appliedFileSync,
    maybeFileSync,
    fileSyncAvailable,
    sessions,
    absentServices,
  };
});

/** Stop phase under the caller's app lock. */
export const stopAppWithPlanUnlocked = Effect.fnUntraced(function* <E>(
  target: ResolvedAppTarget,
  execution: {
    readonly runInitEvents: boolean;
    readonly prepared: StopAppPreflight;
    readonly beforeStop?: Effect.Effect<void, E, EventService>;
  },
): Effect.fn.Return<
  { readonly result: StopAppResult; readonly plan: AppPlan },
  SdkStopAppError | E,
  StopAppServices
> {
  const events = yield* EventService;
  const plan = target.plan;
  const ref = target.app;
  const { prepared: preflight, runInitEvents, beforeStop } = execution;
  const {
    runtimeState,
    provider,
    appliedFileSync,
    maybeFileSync,
    fileSyncAvailable,
    sessions,
    absentServices,
  } = preflight;
  const resolvedEvents = yield* resolveLandofileEventPlan(target);
  const landofileEvents = resolvedEvents.outcome;
  const eventPlan =
    runtimeState === "idle"
      ? yield* idleStopEventPlan(resolvedEvents.plan, runInitEvents)
      : resolvedEvents.plan;

  if (runInitEvents) yield* runAppInitEvents(eventPlan);

  yield* events.publish(
    PreAppStopEvent.make({
      eventName: "pre-app-stop",
      appRef: ref,
      providerId: plan.provider,
      timestamp: now(),
    }),
  );
  const preStop = PreStopEvent.make({ _tag: "pre-stop", scope: "app", app: ref, timestamp: now() });
  yield* publishAndRunAppEvent(eventPlan, "pre-stop", preStop);

  const teardownPlan = preflight.teardownPlan ?? plan;
  const services = Object.values(teardownPlan.services).reverse();
  for (const service of services) {
    yield* events.publish(
      PreServiceStopEvent.make({
        eventName: "pre-service-stop",
        appRef: ref,
        serviceName: service.name,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );
  }

  yield* beforeStop ?? Effect.void;
  const quiesceRetained = provider.quiesceRetainedFileSync;
  const retainedWriters = preflight.retainedWriters;
  // Windows still removes the retained writers of an unfinished accelerated start before stopping.
  let retainedRemoved: readonly ContainerBringDownReceipt[] = [];
  if (retainedWriters !== undefined && quiesceRetained !== undefined) {
    const before = yield* provider.list({ app: plan.id, includeUnplanned: true });
    yield* quiesceRetained(retainedWriters);
    retainedRemoved = before.flatMap((row) =>
      row.containerId !== undefined && Object.hasOwn(retainedWriters.services, row.service)
        ? [{ service: row.service, containerId: row.containerId, action: "removed" as const }]
        : [],
    );
  }
  // App workers retire only once the app's containers are proven stopped; a failed stop keeps them.
  const stopOutcome = yield* runtimeState === "idle"
    ? stopIdleApp(target, preflight)
    : provider.bringDown({ app: plan.id, plan: teardownPlan }, { containers: "stop" });
  const unplanned =
    runtimeState === "idle"
      ? undefined
      : yield* stopUnplannedContainers(teardownPlan, provider).pipe(
          Effect.tap(() => cleanupAppWorkers(ref, "stop")),
        );
  const shutdownObservations: readonly ServiceShutdownObservation[] | undefined = mergeShutdownObservations(
    "shutdownObservations" in stopOutcome ? stopOutcome.shutdownObservations : undefined,
    unplanned?.shutdownObservations,
  );
  const receipts =
    unplanned === undefined
      ? undefined
      : mergeContainerReceipts(
          retainedRemoved,
          "containers" in stopOutcome ? stopOutcome.containers : [],
          unplanned.containers,
        );
  const servicesStopped = servicesTakenDown(receipts);

  if (
    appliedFileSync.status === "accelerated" &&
    Option.isSome(maybeFileSync) &&
    maybeFileSync.value.appLifecycle !== undefined
  ) {
    // An unfinished attempt may not have created any session yet; there is nothing to drain.
    if (runtimeState === "running" && sessions.length > 0) yield* maybeFileSync.value.appLifecycle.drain(ref);
  } else if (runtimeState === "running" && appliedFileSync.status === "accelerated") {
    yield* markUpgradeTeardown(teardownPlan.id);
    const terminate = terminateFileSyncSessions(
      ref,
      fileSyncAvailable ? sessions : undefined,
      absentServices,
    );
    yield* Option.isSome(maybeFileSync)
      ? terminate.pipe(Effect.provideService(FileSyncEngine, maybeFileSync.value))
      : terminate;
  }

  for (const service of services) {
    yield* events.publish(
      PostServiceStopEvent.make({
        eventName: "post-service-stop",
        appRef: ref,
        serviceName: service.name,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );
  }

  yield* events.publish(
    PostAppStopEvent.make({
      eventName: "post-app-stop",
      appRef: ref,
      providerId: plan.provider,
      timestamp: now(),
    }),
  );
  const postStop = PostStopEvent.make({ _tag: "post-stop", scope: "app", app: ref, timestamp: now() });
  const failedPostEvent = yield* publishAndRunPostAppEvent(eventPlan, "post-stop", postStop);

  return {
    result: {
      app: plan.name,
      runtimeState,
      outcome: runtimeState === "idle" || servicesStopped.length > 0 ? "stopped" : "unchanged",
      servicesStopped,
      ...(receipts === undefined ? {} : { containers: receipts }),
      landofileEvents: failedPostEvent ?? landofileEvents,
      ...(shutdownObservations === undefined ? {} : { shutdownObservations }),
    },
    plan,
  };
});
