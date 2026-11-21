import { AppResolveError, FileSyncStopError } from "@lando/sdk/errors";
import { MessageWarnEvent, PostServiceStopEvent, PreServiceStopEvent } from "@lando/sdk/events";
import type {
  AppPlan,
  AppRef,
  FileSyncSessionInfo,
  ServiceName,
  ServiceShutdownObservation,
} from "@lando/sdk/schema";
import {
  EventService,
  type FileSyncEngineShape,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";

import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { routeOwnerFromPlan } from "../lifecycle/route-owner.ts";
import { republishRetainedRoutes } from "../lifecycle/route-withdrawal.ts";
import { hasStopFileSyncCoverage, sessionsStillRequiringStop } from "./file-sync.ts";
import { acquireFileSyncEngine } from "./file-sync-acquire.ts";
import { validateRequested } from "./service-selection.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";
import { retireUnusedGpgAgentWorker } from "./start-gpg-agent.ts";
import { retireUnusedHostProxyWorker } from "./start-host-proxy.ts";
import { retireUnusedSshAgentWorker } from "./start-ssh-agent.ts";
import { absentPlannedServices } from "./stop-internal.ts";

export const requestedStopServices = (
  options: { readonly services?: ReadonlyArray<ServiceName> } | undefined,
): ReadonlyArray<ServiceName> | undefined => {
  const services = options?.services;
  return services !== undefined && services.length > 0 ? services : undefined;
};

const selectedStopNeedsAppliedState = new AppResolveError({
  message: "Selected services cannot be stopped without matching applied app state.",
  reason: "mismatch",
  detail: "provider-resources",
  remediation: "Restore the matching applied state before retrying service-scoped stop.",
});

export const rejectSelectedStopWithoutApplied = () => Effect.fail(selectedStopNeedsAppliedState);

const joinNames = (names: ReadonlyArray<string>): string => {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
};

const quiesceSelectedSessions = Effect.fnUntraced(function* (
  engine: FileSyncEngineShape,
  sessions: ReadonlyArray<FileSyncSessionInfo>,
  mode: "pause" | "terminate",
) {
  for (const session of sessions) {
    if (session.status !== "running") {
      return yield* Effect.fail(
        new FileSyncStopError({
          engineId: engine.id,
          sessionRef: String(session.ref),
          message: `Cannot safely stop a file sync session that is ${session.status}.`,
          remediation: "Repair or resume the file sync session, then retry the command.",
        }),
      );
    }
    yield* engine.flushSession(session.ref);
  }
  for (const session of sessions) {
    if (mode === "pause") yield* engine.pauseSession(session.ref);
    else yield* engine.terminateSession(session.ref);
  }
});

const warnRunningDependents = Effect.fnUntraced(function* (
  plan: AppPlan,
  stopped: ReadonlySet<string>,
  remaining: ReadonlySet<string>,
) {
  if (stopped.size === 0) return;
  const events = yield* EventService;
  for (const service of Object.values(plan.services)) {
    const name = String(service.name);
    if (!remaining.has(name)) continue;
    const dependencies = service.dependsOn
      .map((dependency) => String(dependency.service))
      .filter((dependency) => stopped.has(dependency));
    if (dependencies.length === 0) continue;
    const stoppedLabel = joinNames(dependencies);
    yield* events.publish(
      MessageWarnEvent.make({
        body: `${name} is still running and depends on ${stoppedLabel}, which ${
          dependencies.length === 1 ? "was" : "were"
        } stopped.`,
        timestamp: DateTime.nowUnsafe(),
      }),
    );
  }
});

const retireWorkersForRemaining = Effect.fnUntraced(function* (
  plan: AppPlan,
  app: AppRef,
  remaining: ReadonlySet<string>,
  provider: RuntimeProviderShape,
) {
  const remainingPlan: AppPlan = {
    ...plan,
    services: Object.fromEntries(Object.entries(plan.services).filter(([name]) => remaining.has(name))),
  };
  yield* retireUnusedSshAgentWorker(remainingPlan, app);
  yield* retireUnusedGpgAgentWorker(remainingPlan, app, { forward: true });
  yield* retireUnusedHostProxyWorker(remainingPlan, app, provider.capabilities);
});

const selectedFileSyncStopError = (engineId: string, sessionRef: string) =>
  new FileSyncStopError({
    engineId,
    sessionRef,
    message: "An accelerated mount has no matching active file sync session.",
    remediation: "Inspect and repair the file sync session and provider state, then retry stop.",
  });

const preflightSelectedFileSync = Effect.fnUntraced(function* (
  plan: AppPlan,
  ref: AppRef,
  selected: ReadonlySet<string>,
  absentServices: ReadonlySet<string>,
  provider: RuntimeProviderShape,
) {
  const emptySessions: ReadonlyArray<FileSyncSessionInfo> = [];
  if (provider.inspectAppliedFileSync === undefined) return { engine: undefined, sessions: emptySessions };
  const applied = yield* provider.inspectAppliedFileSync(plan);
  if (applied.status !== "accelerated") return { engine: undefined, sessions: emptySessions };
  const selectedSpecs = applied.sessions.filter((session) => selected.has(String(session.service)));
  if (selectedSpecs.length === 0) return { engine: undefined, sessions: emptySessions };
  const maybeEngine = yield* acquireFileSyncEngine(applied.engineId).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
  const engine = Option.isSome(maybeEngine) ? maybeEngine.value : undefined;
  const engineAvailable = engine !== undefined && (yield* engine.isAvailable);
  const sessions = engineAvailable ? yield* engine.listSessions({ app: ref }) : [];
  const selectedSessions = sessions.filter((session) => selected.has(String(session.service)));
  if (
    engine === undefined ||
    !engineAvailable ||
    !hasStopFileSyncCoverage(selectedSpecs, selectedSessions, absentServices)
  ) {
    return yield* Effect.fail(
      selectedFileSyncStopError(applied.engineId, String(selectedSessions[0]?.ref ?? plan.id)),
    );
  }
  return {
    engine,
    sessions: sessionsStillRequiringStop(selectedSessions, absentServices),
  };
});

/** Remove only the selected services' containers. Sibling resources and applied state stay. */
export const stopSelectedAppServices = Effect.fn("AppOperation.stopSelection")(function* (
  requested: ReadonlyArray<ServiceName>,
  target: ResolvedAppTarget,
) {
  const events = yield* EventService;
  const plan = target.plan;
  const ref = target.app;
  const unique = yield* validateRequested(plan, requested);
  const selected = new Set(unique.map(String));
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(plan);
  const runtimeState = (yield* provider.getStatus).state;
  if (runtimeState === "idle") {
    return {
      app: plan.name,
      outcome: "unchanged" as const,
      runtimeState,
      servicesStopped: [],
      servicesKeptRunning: [],
    };
  }

  const observed = yield* provider.list({ app: plan.id, includeUnplanned: true });
  const owned = observed.filter(
    (service) =>
      service.app === plan.id &&
      service.appRoot === (plan.identity?.appRoot ?? plan.root) &&
      service.providerId === plan.provider &&
      service.containerId !== undefined,
  );
  const absentServices = absentPlannedServices(plan, observed);
  const reverseServices = Object.values(plan.services).reverse();
  const selectedObservations = reverseServices.flatMap((service) =>
    selected.has(String(service.name))
      ? owned.filter((observation) => observation.service === service.name)
      : [],
  );
  const selectedWithContainers = new Set(selectedObservations.map((service) => String(service.service)));
  const remainingAfterStop = new Set(
    Object.keys(plan.services).filter((name) => !absentServices.has(name) && !selected.has(name)),
  );

  const fileSync = yield* preflightSelectedFileSync(plan, ref, selected, absentServices, provider);

  for (const service of reverseServices) {
    if (!selectedWithContainers.has(String(service.name))) continue;
    yield* events.publish(
      PreServiceStopEvent.make({
        eventName: "pre-service-stop",
        appRef: ref,
        serviceName: service.name,
        providerId: plan.provider,
        timestamp: DateTime.nowUnsafe(),
      }),
    );
  }

  const servicesStopped: string[] = [];
  const observationSources: Array<readonly ServiceShutdownObservation[] | undefined> = [];
  for (const service of selectedObservations) {
    const result = yield* provider.removeObservedService(service);
    observationSources.push(result.shutdownObservations);
    switch (result.kind) {
      case "removed":
        servicesStopped.push(String(service.service));
        break;
      case "absent":
        break;
      default: {
        const unreachable: never = result;
        return unreachable;
      }
    }
  }

  for (const service of reverseServices) {
    if (!selectedWithContainers.has(String(service.name))) continue;
    yield* events.publish(
      PostServiceStopEvent.make({
        eventName: "post-service-stop",
        appRef: ref,
        serviceName: service.name,
        providerId: plan.provider,
        timestamp: DateTime.nowUnsafe(),
      }),
    );
  }

  yield* warnRunningDependents(plan, new Set(servicesStopped), remainingAfterStop);

  if (fileSync.engine !== undefined && fileSync.sessions.length > 0) {
    yield* quiesceSelectedSessions(
      fileSync.engine,
      fileSync.sessions,
      fileSync.engine.appLifecycle === undefined ? "terminate" : "pause",
    );
  }

  const updateRoutes = plan.routes.some((route) => selected.has(String(route.service)));
  if (updateRoutes) {
    const retained = plan.routes.filter(
      (route) => !selected.has(String(route.service)) && remainingAfterStop.has(String(route.service)),
    );
    yield* republishRetainedRoutes(
      retained,
      routeOwnerFromPlan(plan),
      unique.map((name) => String(name)),
    );
  }

  yield* retireWorkersForRemaining(plan, ref, remainingAfterStop, provider);

  return withShutdownObservations(
    {
      app: plan.name,
      outcome: servicesStopped.length > 0 ? ("stopped" as const) : ("unchanged" as const),
      runtimeState,
      servicesStopped,
      servicesKeptRunning: [...remainingAfterStop].sort(),
    },
    ...observationSources,
  );
});
