import { isProviderError, redactProviderError } from "@lando/redaction/provider-error";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { FailureRoleAnnotation, mapDefectCause, mapFailures, raceJoined } from "@lando/sdk/command-result";
import { ServiceExecError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type HealthcheckPlan,
  type ServiceDependencyCondition,
  type ServicePlan,
  effectiveReadiness,
  probeTargetError,
} from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ProviderError } from "@lando/sdk/services";
import { Cause, Context, Effect, Exit } from "effect";

import { gateId, gateNodeId } from "./dependency-gates.ts";
import { type ScheduleEdge, type ScheduleGraph, runDependencySchedule } from "./dependency-schedule.ts";
import { boundHealthcheckAttempt, runHealthcheckPhases } from "./healthcheck-probe.ts";

export type DependencyExit = { readonly containerId: string } & (
  | { readonly status: "exited"; readonly exitCode?: number }
  | { readonly status: "dead"; readonly exitCode?: never }
);

export type DependencyUnavailableReason = "missing" | "replaced" | "unverified";

export type HostProbeObservation =
  | {
      readonly _tag: "Retry";
      readonly timedOut?: true;
      readonly dependencyUnavailable?: { readonly reason: DependencyUnavailableReason };
    }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Terminal"; readonly exit: DependencyExit };

export type DependencyWatchResult =
  | { readonly _tag: "Terminal"; readonly exit: DependencyExit }
  | { readonly _tag: "Disarmed"; readonly reason?: DependencyUnavailableReason };

export type CompletionWaitResult =
  | { readonly dependencyExit: DependencyExit }
  | { readonly dependencyUnavailable: { readonly reason: DependencyUnavailableReason } };

interface ScheduledStart {
  readonly changed: boolean;
  readonly terminalExit?: DependencyExit;
  readonly dependencyUnavailable?: { readonly reason: DependencyUnavailableReason };
}

/**
 * Provider-side realization of `depends_on` conditions.
 *
 * Services are started behind synthetic gate nodes rather than in whatever order
 * `Object.values(plan.services)` happens to yield. A gate is satisfied by the
 * dependency reaching the state its condition names; optionality lives on the
 * EDGE, so one shared gate can block a required dependent while an optional
 * dependent proceeds past the same failure.
 */
export type ServiceStartNode =
  | { readonly _tag: "service"; readonly service: ServicePlan }
  | {
      readonly _tag: "gate";
      readonly service: ServicePlan;
      readonly condition: ServiceDependencyCondition;
    };

export interface BlockedService {
  readonly service: string;
  readonly unmetGate: string;
  readonly dependency: string;
  readonly lastExitCode?: number;
  readonly timedOut?: boolean;
  readonly lastError?: string;
  readonly dependencyExit?: DependencyExit;
  readonly dependencyUnavailable?: { readonly reason: DependencyUnavailableReason };
}

export type ServiceStartResult =
  | { readonly _tag: "Cycle"; readonly edges: ReadonlyArray<string> }
  | {
      readonly _tag: "Settled";
      readonly changed: boolean;
      readonly blocked: ReadonlyArray<BlockedService>;
    };

export interface ServiceStartHandlers<E, R> {
  readonly redactor?: Redactor;
  readonly redactProbeError?: (error: unknown) => string;
  /** Brings one service up. Only optional-only start failures are tolerated. */
  readonly startService: (service: ServicePlan) => Effect.Effect<ScheduledStart, E, R>;
  /** Runs one healthcheck attempt at its declared execution target. */
  readonly execHealthcheck: (
    service: ServicePlan,
    probe: HealthcheckPlan,
  ) => Effect.Effect<{ readonly exitCode: number; readonly stderr?: string }, unknown, R>;
  readonly checkHostProbeGreen?: (service: ServicePlan) => Effect.Effect<HostProbeObservation, E, R>;
  /**
   * Arms one exit wait after start is acknowledged. Terminal ends the healthy gate;
   * Disarmed rejoins the original probe loop without re-arming.
   */
  readonly watchDependencyExit?: (service: ServicePlan) => Effect.Effect<DependencyWatchResult, E, R>;
  /** Waits for a one-shot service and returns verified exit evidence. */
  readonly waitForExit: (service: ServicePlan) => Effect.Effect<CompletionWaitResult, E, R>;
}

/** The schedule node id that starts `service`. */
export const serviceStartNodeId = (service: string): string => `svc:${service}`;

export const buildServiceStartGraph = (plan: AppPlan): ScheduleGraph<ServiceStartNode> => {
  const services = Object.values(plan.services).sort((left, right) =>
    String(left.name).localeCompare(String(right.name)),
  );
  const byName = new Map(services.map((service) => [String(service.name), service]));
  const nodes: Array<{ readonly id: string; readonly value: ServiceStartNode }> = services.map((service) => ({
    id: serviceStartNodeId(String(service.name)),
    value: { _tag: "service", service },
  }));
  const gates = new Map<string, ServiceStartNode>();
  const edges: Array<ScheduleEdge> = [];

  for (const dependent of services) {
    for (const dependency of dependent.dependsOn) {
      const target = byName.get(String(dependency.service));
      if (target === undefined) continue;
      const id = gateNodeId(String(target.name), dependency.condition);
      if (!gates.has(id)) {
        gates.set(id, { _tag: "gate", service: target, condition: dependency.condition });
        edges.push({
          predecessor: serviceStartNodeId(String(target.name)),
          dependent: id,
          required: true,
        });
      }
      edges.push({
        predecessor: id,
        dependent: serviceStartNodeId(String(dependent.name)),
        required: dependency.required,
      });
    }
  }

  return {
    nodes: [...nodes, ...[...gates.entries()].map(([id, value]) => ({ id, value }))],
    edges,
  };
};

interface GateProbeResult {
  readonly ok: boolean;
  readonly lastExitCode?: number;
  readonly timedOut?: boolean;
  readonly lastError?: string;
  readonly dependencyExit?: DependencyExit;
  readonly dependencyUnavailable?: { readonly reason: DependencyUnavailableReason };
}

const completionGateResult = (result: CompletionWaitResult): GateProbeResult => {
  if ("dependencyUnavailable" in result) {
    return { ok: false, dependencyUnavailable: result.dependencyUnavailable };
  }
  const exit = result.dependencyExit;
  return {
    ok: exit.status === "exited" && exit.exitCode === 0,
    dependencyExit: exit,
  };
};

type Attempt =
  | { readonly _tag: "Ready" }
  | ({ readonly _tag: "Retry" } & Omit<GateProbeResult, "ok" | "dependencyExit">);

class HostDependencyExited {
  constructor(readonly exit: DependencyExit) {}
}

const probeHealthy = Effect.fnUntraced(function* <E, R>(
  service: ServicePlan,
  handlers: ServiceStartHandlers<E, R>,
): Effect.fn.Return<GateProbeResult, E | ProviderError, R> {
  const healthcheck = effectiveReadiness(service);
  if (healthcheck === undefined || healthcheck.kind !== "command" || healthcheck.command === undefined)
    return { ok: false };

  const command = Effect.gen(function* (): Effect.fn.Return<Attempt, ProviderError, R> {
    const result = yield* Effect.exit(handlers.execHealthcheck(service, healthcheck));
    if (Exit.isSuccess(result)) {
      return result.value.exitCode === 0
        ? { _tag: "Ready" }
        : {
            _tag: "Retry",
            lastExitCode: result.value.exitCode,
            ...(result.value.stderr
              ? {
                  lastError: (
                    handlers.redactProbeError?.(result.value.stderr) ?? "Readiness command failed."
                  ).slice(0, 2048),
                }
              : {}),
          };
    }
    const [failure] = result.cause.reasons;
    if (
      result.cause.reasons.length !== 1 ||
      failure?._tag !== "Fail" ||
      Context.getOrUndefined(Cause.reasonAnnotations(failure), FailureRoleAnnotation) !== undefined
    ) {
      const redactor = handlers.redactor ?? createStandaloneRedactor("secrets");
      return yield* Effect.failCause(mapDefectCause(result.cause, () => "Readiness command defect.")).pipe(
        mapFailures((error) =>
          isProviderError(error)
            ? redactProviderError(error, redactor, { cause: "omit" })
            : new ServiceExecError({
                providerId: service.provider,
                service: String(service.name),
                operation: "readiness",
                message: "Readiness command failed while settling the attempt.",
                remediation: "Run `lando doctor` to check the runtime provider.",
              }),
        ),
      );
    }
    return {
      _tag: "Retry",
      lastError: (
        handlers.redactProbeError?.(failure.error) ?? "Readiness attempt infrastructure failure."
      ).slice(0, 2048),
    };
  });
  const attempt = Effect.gen(function* (): Effect.fn.Return<
    Attempt,
    E | ProviderError | HostDependencyExited,
    R
  > {
    const checked = yield* boundHealthcheckAttempt(healthcheck, command);
    if (checked._tag === "TimedOut") return { _tag: "Retry", timedOut: true };
    if (checked.value._tag === "Retry" || healthcheck.executionTarget !== "host") return checked.value;
    const observation = yield* handlers.checkHostProbeGreen?.(service) ??
      Effect.succeed({ _tag: "Retry" as const });
    switch (observation._tag) {
      case "Terminal":
        return yield* Effect.fail(new HostDependencyExited(observation.exit));
      case "Running":
        return { _tag: "Ready" };
      case "Retry":
        return observation;
    }
  });

  const runProbeLoop = runHealthcheckPhases(
    { id: `service-start-health:${String(service.name)}`, plan: healthcheck },
    attempt,
    (value) => value._tag === "Ready",
  ).pipe(
    Effect.map(({ result, last }): GateProbeResult => {
      if (last?.value._tag !== "Retry") return { ok: result.outcome === "green" };
      const { _tag, ...evidence } = last.value;
      return { ok: false, ...evidence };
    }),
    Effect.catchCause((cause) => {
      const [reason] = cause.reasons;
      if (
        cause.reasons.length === 1 &&
        reason !== undefined &&
        Cause.isFailReason(reason) &&
        reason.error instanceof HostDependencyExited
      )
        return Effect.succeed<GateProbeResult>({ ok: false, dependencyExit: reason.error.exit });
      return Effect.failCause(cause).pipe(
        mapFailures((error) =>
          error instanceof HostDependencyExited
            ? new ServiceExecError({
                providerId: service.provider,
                service: String(service.name),
                operation: "readiness",
                message: "The readiness probe could not settle.",
                remediation: "Run `lando doctor` to check the runtime provider.",
              })
            : error,
        ),
      );
    }),
  );

  const watch = handlers.watchDependencyExit;
  if (watch === undefined) return yield* runProbeLoop;

  type RaceSide =
    | { readonly _tag: "Probe"; readonly gate: GateProbeResult }
    | { readonly _tag: "Watch"; readonly exit: DependencyExit };

  // Disarm keeps the watcher fiber alive until the probe cancels it, so the original
  // probe loop keeps its remaining budget and is never restarted or re-armed.
  let unavailable: DependencyUnavailableReason | undefined;
  const raced = yield* raceJoined(
    runProbeLoop.pipe(Effect.map((gate): RaceSide => ({ _tag: "Probe", gate }))),
    watch(service).pipe(
      Effect.flatMap((value) => {
        if (value._tag === "Terminal") return Effect.succeed({ _tag: "Watch" as const, exit: value.exit });
        unavailable = value.reason;
        return Effect.never;
      }),
    ),
    (winner, peer) => (peer._tag === "Watch" ? peer : winner),
  );

  if (raced._tag === "Watch") return { ok: false, dependencyExit: raced.exit };
  if (raced.gate.ok || raced.gate.dependencyExit !== undefined || unavailable === undefined)
    return raced.gate;
  return {
    ...raced.gate,
    dependencyUnavailable: raced.gate.dependencyUnavailable ?? { reason: unavailable },
  };
});

export const runServiceStartSchedule = Effect.fn("RuntimeProvider.startSchedule")(function* <E, R>(
  plan: AppPlan,
  handlers: ServiceStartHandlers<E, R>,
): Effect.fn.Return<ServiceStartResult, E | ProviderError, R> {
  for (const service of Object.values(plan.services)) {
    for (const role of ["healthcheck", "readiness"] as const) {
      const probe = service[role];
      if (probe === undefined) continue;
      const invalid = probeTargetError(probe, service.name, role);
      if (invalid !== undefined) return yield* Effect.fail(invalid);
    }
  }
  const graph = buildServiceStartGraph(plan);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node.value]));
  const optionalOnlyServices = new Set(
    graph.nodes.flatMap((node) => {
      if (node.value._tag !== "service") return [];
      const gateIds = graph.edges
        .filter((edge) => edge.predecessor === node.id)
        .map((edge) => edge.dependent);
      if (gateIds.length === 0) return [];
      const consumers = graph.edges.filter((edge) => gateIds.includes(edge.predecessor));
      return consumers.length > 0 && consumers.every((edge) => !edge.required) ? [node.id] : [];
    }),
  );
  const blocked: Array<BlockedService> = [];
  const gateOutcomes = new Map<string, Omit<GateProbeResult, "ok">>();
  const startFailures = new Map<string, Omit<GateProbeResult, "ok">>();
  let changed = false;

  const recordGateOutcome = (
    nodeId: string,
    { ok, ...evidence }: GateProbeResult,
  ): "succeeded" | "failed" => {
    gateOutcomes.set(nodeId, evidence);
    return ok ? "succeeded" : "failed";
  };

  const settled = yield* runDependencySchedule(graph, {
    concurrency: 1,
    run: (node, blockedBy) => {
      const value = node.value;
      const [unmetGate] = blockedBy;
      if (unmetGate !== undefined) {
        if (value._tag === "gate") {
          const evidence = startFailures.get(unmetGate);
          if (evidence !== undefined)
            return Effect.succeed(recordGateOutcome(node.id, { ok: false, ...evidence }));
        }
        if (value._tag === "service") {
          const unmet = nodeById.get(unmetGate);
          const dependency = unmet?._tag === "gate" ? String(unmet.service.name) : unmetGate;
          const outcome = gateOutcomes.get(unmetGate) ?? {};
          blocked.push({
            service: String(value.service.name),
            unmetGate:
              unmet?._tag === "gate" ? gateId(String(unmet.service.name), unmet.condition) : unmetGate,
            dependency,
            ...outcome,
          });
        }
        return Effect.succeed("blocked" as const);
      }
      if (value._tag === "service") {
        const start = handlers.startService(value.service).pipe(
          Effect.map((result) => {
            changed = changed || result.changed;
            if (result.terminalExit !== undefined || result.dependencyUnavailable !== undefined) {
              startFailures.set(node.id, {
                ...(result.terminalExit === undefined ? {} : { dependencyExit: result.terminalExit }),
                ...(result.dependencyUnavailable === undefined
                  ? {}
                  : { dependencyUnavailable: result.dependencyUnavailable }),
              });
              return "failed" as const;
            }
            return "succeeded" as const;
          }),
        );
        return optionalOnlyServices.has(node.id)
          ? start.pipe(Effect.catch(() => Effect.succeed("failed" as const)))
          : start;
      }
      switch (value.condition) {
        case "service_started":
          return Effect.succeed("succeeded" as const);
        case "service_healthy":
          return probeHealthy(value.service, handlers).pipe(
            Effect.map((result) => recordGateOutcome(node.id, result)),
          );
        case "service_completed_successfully":
          // Provider errors propagate; optional edges forgive gate verdicts only.
          return handlers
            .waitForExit(value.service)
            .pipe(Effect.map((result) => recordGateOutcome(node.id, completionGateResult(result))));
      }
    },
  });

  if (settled._tag === "Cycle") return { _tag: "Cycle", edges: settled.edges };
  return { _tag: "Settled", changed, blocked };
});
