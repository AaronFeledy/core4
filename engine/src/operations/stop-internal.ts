import { DateTime, Effect, Option } from "effect";

import type { StopAppError as SdkStopAppError, StopAppOptions, StopAppResult } from "@lando/sdk/app";
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
import type { AppPlan, FileSyncSessionInfo, ServiceShutdownObservation } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type AppliedFileSyncInspection,
  EventService,
  FileSyncEngine,
  type FileSyncEngineShape,
  type LandofileService,
  PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type StateStore,
} from "@lando/sdk/services";

import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";

import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { cleanupHostProxyRunLandoState } from "../subsystems/host-proxy/transport.ts";
import { cleanupAgentRelayState } from "../subsystems/ssh-agent/cleanup.ts";
import { acceleratedStartStopError } from "./accelerated-start-disposal.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { recordedSessionInventory } from "./accelerated-start-resume.ts";
import { publishAndRunAppEvent, publishAndRunPostAppEvent, runAppInitEvents } from "./events.ts";
import { acquireFileSyncEngine } from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { hasExactFileSyncSessionCoverage, terminateFileSyncSessions } from "./file-sync.ts";
import { resolveLandofileEventPlan } from "./landofile-events.ts";

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
  readonly provider: RuntimeProviderShape;
  readonly appliedFileSync: AppliedFileSyncInspection;
  readonly maybeFileSync: Option.Option<FileSyncEngineShape>;
  readonly fileSyncAvailable: boolean;
  readonly sessions: ReadonlyArray<FileSyncSessionInfo>;
}

/** Verify the provider's saved mount state before any app hook or writer shutdown. */
export const preflightStopApp = Effect.fnUntraced(function* (
  target: ResolvedAppTarget,
): Effect.fn.Return<StopAppPreflight, SdkStopAppError, RuntimeProviderRegistry | StateStore> {
  const pending = yield* readPendingAcceleratedStart(target.app, target.plan).pipe(
    mapFailureErrors((cause) => acceleratedStartStopError(target.app, cause)),
  );
  const registry = yield* RuntimeProviderRegistry;
  const plan = target.plan;
  const provider = yield* registry.select(plan);
  if (pending !== null) {
    const bundle = yield* fileSyncBundle(plan).pipe(
      mapFailureErrors((cause) => acceleratedStartStopError(target.app, cause)),
    );
    const { engine, sessions } = yield* recordedSessionInventory(target.app, pending, plan).pipe(
      mapFailureErrors((cause) => acceleratedStartStopError(target.app, cause)),
    );
    return {
      provider,
      appliedFileSync: {
        status: "accelerated",
        engineId: pending.engineId,
        sessions: bundle.sessions,
      },
      maybeFileSync: Option.some(engine),
      fileSyncAvailable: true,
      sessions,
    };
  }
  const ref = target.app;
  const bundle =
    provider.inspectAppliedFileSync === undefined
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
  const maybeFileSync =
    appliedFileSync.status === "accelerated"
      ? yield* acquireFileSyncEngine(appliedFileSync.engineId).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none())),
        )
      : Option.none();
  const fileSyncAvailable =
    appliedFileSync.status === "accelerated" &&
    Option.isSome(maybeFileSync) &&
    (yield* maybeFileSync.value.isAvailable);
  const sessions =
    fileSyncAvailable && Option.isSome(maybeFileSync)
      ? yield* maybeFileSync.value.listSessions({ app: ref })
      : [];
  if (
    appliedFileSync.status === "unknown" ||
    (appliedFileSync.status === "accelerated" &&
      (Option.isNone(maybeFileSync) ||
        maybeFileSync.value.id !== appliedFileSync.engineId ||
        !hasExactFileSyncSessionCoverage(appliedFileSync.sessions, sessions)))
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

  return { provider, appliedFileSync, maybeFileSync, fileSyncAvailable, sessions };
});

const stopAppWithResolvedPlan = Effect.fnUntraced(function* (
  _options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
  runInitEvents: boolean,
  prepared?: StopAppPreflight,
): Effect.fn.Return<
  { readonly result: StopAppResult; readonly plan: AppPlan },
  SdkStopAppError,
  StopAppServices
> {
  const events = yield* EventService;
  const paths = yield* PathsService;
  const plan = target.plan;
  const ref = target.app;
  const { provider, appliedFileSync, maybeFileSync, fileSyncAvailable, sessions } =
    prepared ?? (yield* preflightStopApp(target));
  const { plan: eventPlan, outcome: landofileEvents } = yield* resolveLandofileEventPlan(target);

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

  const services = Object.values(plan.services).reverse();
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

  const destroyOutcome = yield* provider
    .destroy({ app: plan.id, plan }, { volumes: false, removeState: false })
    .pipe(
      Effect.ensuring(cleanupHostProxyRunLandoState(ref, { ...paths.roots, platform: paths.platform })),
      Effect.ensuring(cleanupAgentRelayState(ref, { ...paths.roots, platform: paths.platform }, "ssh")),
      Effect.ensuring(cleanupAgentRelayState(ref, { ...paths.roots, platform: paths.platform }, "gpg")),
    );
  const shutdownObservations: readonly ServiceShutdownObservation[] | undefined =
    destroyOutcome.shutdownObservations;

  if (
    appliedFileSync.status === "accelerated" &&
    Option.isSome(maybeFileSync) &&
    maybeFileSync.value.appLifecycle !== undefined
  ) {
    // An unfinished attempt may not have created any session yet; there is nothing to drain.
    if (sessions.length > 0) yield* maybeFileSync.value.appLifecycle.drain(ref);
  } else if (appliedFileSync.status === "accelerated") {
    const terminate = terminateFileSyncSessions(ref, fileSyncAvailable ? sessions : undefined);
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
  yield* publishAndRunPostAppEvent(eventPlan, "post-stop", postStop);

  return {
    result: {
      app: plan.name,
      servicesStopped: services.map((service) => String(service.name)),
      landofileEvents,
      ...(shutdownObservations === undefined ? {} : { shutdownObservations }),
    },
    plan,
  };
});

/** Internal stop phase used only while restart/rebuild already hold the app lock. */
export const stopAppWithPlanUnlocked = (
  options: StopAppOptions,
  target: ResolvedAppTarget,
  runInitEvents = false,
  prepared?: StopAppPreflight,
) => stopAppWithResolvedPlan(options, target, runInitEvents, prepared);
