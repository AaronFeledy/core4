import { AppResolveError, FileSyncStopError } from "@lando/sdk/errors";
import { MessageWarnEvent, PostServiceStopEvent, PreServiceStopEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type AppRef,
  type ServiceName,
  type ServiceShutdownObservation,
  type StopAppResult,
  isDownRunStatus,
  isIdleRunStatus,
} from "@lando/sdk/schema";
import {
  EventService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { DateTime, Effect } from "effect";

import { routerEnabled } from "../config/router-config.ts";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { routeOwnerFromPlan } from "../lifecycle/route-owner.ts";
import { republishRetainedRoutes } from "../lifecycle/route-withdrawal.ts";
import { type PendingStart, recordedStartCommand } from "./accelerated-start-record.ts";
import { preflightSelectedStopFileSync, quiesceSelectedStopFileSync } from "./file-sync.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";
import { retireUnusedGpgAgentWorker } from "./start-gpg-agent.ts";
import { retireUnusedHostProxyWorker } from "./start-host-proxy.ts";
import { retireUnusedSshAgentWorker } from "./start-ssh-agent.ts";

/** The services a stop selects; omitted and empty selections both mean the whole app. */
export const requestedStopServices = (
  options: { readonly services?: ReadonlyArray<ServiceName> } | undefined,
): ReadonlyArray<ServiceName> | undefined => {
  const services = options?.services;
  return services !== undefined && services.length > 0 ? services : undefined;
};

/** What a selected stop knows about the app before it observes the runtime. */
export interface SelectedStopEvidence {
  /** An unfinished accelerated start, which owns the sessions a stop would quiesce. */
  readonly journal: PendingStart | undefined;
  readonly rootExists: boolean;
  /** `unrecorded`: containers or ownership records exist without an applied plan. */
  readonly record: "applied" | "unrecorded" | "none";
}

/**
 * The one rule set that refuses a selected stop. An unfinished start refuses first, for every
 * resolution, and names the command that finishes it. A missing app folder or resources without
 * an applied record refuse next: without applied route definitions, selected stop cannot tell
 * which routes to keep. Anything else may proceed.
 */
export const selectedStopRefusal = (
  evidence: SelectedStopEvidence,
): FileSyncStopError | AppResolveError | undefined => {
  if (evidence.journal !== undefined)
    return new FileSyncStopError({
      engineId: evidence.journal.engineId,
      sessionRef: evidence.journal.appId,
      message: "Selected stop cannot run while an accelerated start is unfinished.",
      remediation: `Run \`${recordedStartCommand(evidence.journal)}\` to finish the attempt, or \`lando stop\` without --service.`,
    });
  if (!evidence.rootExists || evidence.record === "unrecorded")
    return new AppResolveError({
      message: "Selected services can only be stopped while the app folder and its applied state both exist.",
      reason: "mismatch",
      detail: "provider-resources",
      remediation:
        "Run `lando stop` without --service; it stops the containers Lando can prove belong to this app.",
    });
  return undefined;
};

/** Containers of this app on this provider, matched by the plan's identity. */
const ownedContainers = (plan: AppPlan, observed: ReadonlyArray<ServiceRuntimeInfo>) =>
  observed.filter(
    (service) =>
      service.app === plan.id &&
      service.appRoot === (plan.identity?.appRoot ?? plan.root) &&
      service.providerId === plan.provider &&
      service.containerId !== undefined,
  );

/**
 * Planned services with no writer left: no owned container, or one that is provably not executing.
 * A paused, restarting, departing, or unreadable container may still write, so it is not absent.
 */
export const absentPlannedServices = (
  plan: AppPlan,
  observed: ReadonlyArray<ServiceRuntimeInfo>,
): ReadonlySet<string> => {
  const present = new Set(
    ownedContainers(plan, observed)
      .filter((service) => !isIdleRunStatus(service.status))
      .map((service) => String(service.service)),
  );
  return new Set(Object.keys(plan.services).filter((name) => !present.has(name)));
};

const joinNames = (names: ReadonlyArray<string>): string => {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
};

const warnRunningDependents = Effect.fnUntraced(function* (
  plan: AppPlan,
  stopped: ReadonlySet<string>,
  running: ReadonlySet<string>,
) {
  if (stopped.size === 0) return;
  const events = yield* EventService;
  for (const service of Object.values(plan.services)) {
    const name = String(service.name);
    if (!running.has(name)) continue;
    const dependencies = service.dependsOn
      .map((dependency) => String(dependency.service))
      .filter((dependency) => stopped.has(dependency));
    if (dependencies.length === 0) continue;
    yield* events.publish(
      MessageWarnEvent.make({
        body: `${name} is still running and depends on ${joinNames(dependencies)}, which ${
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

/**
 * Remove only the validated selected services' containers. Sibling containers, named volumes,
 * networking, and applied state stay. `applied` says whether the target has an applied record.
 */
export const stopSelectedAppServices = Effect.fn("AppOperation.stopSelection")(function* (
  services: ReadonlyArray<ServiceName>,
  target: ResolvedAppTarget,
  applied: boolean,
) {
  const events = yield* EventService;
  const plan = target.plan;
  const ref = target.app;
  const selected = new Set(services.map(String));
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(plan);
  const runtimeState = (yield* provider.getStatus).state;
  const unchanged: StopAppResult = {
    app: plan.name,
    outcome: "unchanged",
    runtimeState,
    servicesStopped: [],
    servicesKeptRunning: [],
  };
  if (runtimeState === "idle") return unchanged;

  const observed = yield* provider.list({ app: plan.id, includeUnplanned: true });
  const owned = ownedContainers(plan, observed);
  if (!applied) {
    const refusal = selectedStopRefusal({
      journal: undefined,
      rootExists: true,
      record: owned.length > 0 ? "unrecorded" : "none",
    });
    return refusal === undefined ? unchanged : yield* Effect.fail(refusal);
  }

  const absentServices = absentPlannedServices(plan, observed);
  const up = new Set(
    owned.filter((service) => !isDownRunStatus(service.status)).map((service) => String(service.service)),
  );
  const remaining = new Set(
    Object.keys(plan.services).filter((name) => !absentServices.has(name) && !selected.has(name)),
  );
  const fileSync = yield* preflightSelectedStopFileSync(plan, ref, selected, absentServices, provider);

  const servicesStopped: string[] = [];
  const observationSources: Array<readonly ServiceShutdownObservation[] | undefined> = [];
  for (const service of Object.values(plan.services).reverse()) {
    if (!selected.has(String(service.name))) continue;
    const containers = owned.filter((observation) => observation.service === service.name);
    if (containers.length === 0) continue;
    const lifecycle = { appRef: ref, serviceName: service.name, providerId: plan.provider };
    yield* events.publish(
      PreServiceStopEvent.make({
        eventName: "pre-service-stop",
        ...lifecycle,
        timestamp: DateTime.nowUnsafe(),
      }),
    );
    for (const container of containers) {
      const result = yield* provider.removeObservedService(container);
      observationSources.push(result.shutdownObservations);
      switch (result.kind) {
        case "removed":
          if (!servicesStopped.includes(String(service.name))) servicesStopped.push(String(service.name));
          break;
        case "absent":
          break;
        default:
          return result satisfies never;
      }
    }
    yield* events.publish(
      PostServiceStopEvent.make({
        eventName: "post-service-stop",
        ...lifecycle,
        timestamp: DateTime.nowUnsafe(),
      }),
    );
  }

  const keptRunning = new Set([...remaining].filter((name) => up.has(name)));
  yield* warnRunningDependents(plan, new Set(servicesStopped), keptRunning);

  if (routerEnabled(plan) && plan.routes.some((route) => selected.has(String(route.service)))) {
    yield* republishRetainedRoutes(
      plan.routes.filter((route) => keptRunning.has(String(route.service))),
      routeOwnerFromPlan(plan),
      [...selected],
    );
  }
  yield* quiesceSelectedStopFileSync(fileSync);
  yield* retireWorkersForRemaining(plan, ref, remaining, provider);

  return withShutdownObservations(
    {
      app: plan.name,
      outcome: servicesStopped.length > 0 ? ("stopped" as const) : ("unchanged" as const),
      runtimeState,
      servicesStopped,
      servicesKeptRunning: [...keptRunning].sort(),
    },
    ...observationSources,
  );
});
