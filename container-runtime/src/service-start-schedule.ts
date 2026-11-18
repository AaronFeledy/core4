import { mapDefectCause, mapFailures } from "@lando/sdk/command-result";
import { type HealthcheckTargetUnsupportedError, ServiceExecError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type HealthcheckPlan,
  type ServiceDependencyCondition,
  type ServicePlan,
  effectiveReadiness,
  probeTargetError,
} from "@lando/sdk/schema";
import { type Cause, Duration, Effect, Exit } from "effect";

import { gateId, gateNodeId } from "./dependency-gates.ts";
import { type ScheduleEdge, type ScheduleGraph, runDependencySchedule } from "./dependency-schedule.ts";
import { runHealthcheckPhases } from "./healthcheck-probe.ts";

export type DependencyExit = { readonly containerId: string } & (
  | { readonly status: "exited"; readonly exitCode?: number }
  | { readonly status: "dead"; readonly exitCode?: never }
);

export type DependencyObservation =
  | { readonly _tag: "Inconclusive" }
  | { readonly _tag: "Restarting" }
  | { readonly _tag: "Exited"; readonly exit: DependencyExit };

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
}

export type ServiceStartResult =
  | { readonly _tag: "Cycle"; readonly edges: ReadonlyArray<string> }
  | {
      readonly _tag: "Settled";
      readonly changed: boolean;
      readonly blocked: ReadonlyArray<BlockedService>;
    };

export interface ServiceStartHandlers<E, R> {
  readonly redactProbeError?: (error: unknown) => string;
  /** Brings one service up. Only optional-only start failures are tolerated. */
  readonly startService: (service: ServicePlan) => Effect.Effect<{ readonly changed: boolean }, E, R>;
  /** Runs one healthcheck attempt at its declared execution target. */
  readonly execHealthcheck: (
    service: ServicePlan,
    probe: HealthcheckPlan,
  ) => Effect.Effect<{ readonly exitCode: number; readonly stderr?: string }, unknown, R>;
  readonly observeHealthyDependency?: (service: ServicePlan) => Effect.Effect<DependencyObservation, E, R>;
  /** Waits for a one-shot service and returns its verified exit code, if observed. */
  readonly waitForExit: (service: ServicePlan) => Effect.Effect<{ readonly exitCode?: number }, unknown, R>;
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
}

const probeHealthy = Effect.fnUntraced(function* <E, R>(
  service: ServicePlan,
  handlers: ServiceStartHandlers<E, R>,
): Effect.fn.Return<GateProbeResult, E | ServiceExecError, R> {
  const healthcheck = effectiveReadiness(service);
  if (healthcheck === undefined || healthcheck.kind !== "command" || healthcheck.command === undefined)
    return { ok: false };

  let lastExitCode: number | undefined;
  let timedOut = false;
  let lastError: string | undefined;
  const command = Effect.gen(function* () {
    const result = yield* Effect.exit(handlers.execHealthcheck(service, healthcheck));
    timedOut = false;
    if (Exit.isSuccess(result)) {
      lastError =
        result.value.exitCode === 0 || !result.value.stderr
          ? undefined
          : (handlers.redactProbeError?.(result.value.stderr) ?? "Readiness command failed.").slice(0, 2048);
      lastExitCode = result.value.exitCode;
      return result.value.exitCode === 0;
    }
    const [failure] = result.cause.reasons;
    if (result.cause.reasons.length !== 1 || failure?._tag !== "Fail") {
      return yield* Effect.failCause(mapDefectCause(result.cause, () => "Readiness command defect.")).pipe(
        mapFailures(
          () =>
            new ServiceExecError({
              providerId: service.provider,
              service: String(service.name),
              operation: "readiness",
              message: "Readiness command failed while settling the attempt.",
              remediation: "Run `lando doctor` to check the runtime provider.",
            }),
        ),
      );
    }
    lastExitCode = undefined;
    lastError = (
      handlers.redactProbeError?.(failure.error) ?? "Readiness attempt infrastructure failure."
    ).slice(0, 2048);
    return false;
  });
  let dependencyExit: DependencyExit | undefined;
  let exceptional: Cause.Cause<E | ServiceExecError> | undefined;
  const attempt = Effect.gen(function* () {
    const ready = yield* command.pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(healthcheck.timeoutSeconds),
        orElse: () =>
          Effect.sync(() => {
            timedOut = true;
            lastExitCode = undefined;
            lastError = undefined;
            return false;
          }),
      }),
    );
    if (ready && healthcheck.executionTarget !== "host") return true;
    const observation = yield* handlers.observeHealthyDependency?.(service) ??
      Effect.succeed({ _tag: "Inconclusive" as const });
    switch (observation._tag) {
      case "Exited":
        dependencyExit = observation.exit;
        return true;
      case "Restarting":
        return false;
      case "Inconclusive":
        return ready;
    }
  }).pipe(
    Effect.catchCause((cause) => {
      exceptional = cause;
      return Effect.succeed(true);
    }),
  );
  const result = yield* runHealthcheckPhases(
    { id: `service-start-health:${String(service.name)}`, plan: healthcheck },
    attempt,
    (settled) => settled === true,
  ).pipe(Effect.catchTag("ProbeError", (error) => Effect.die(error)));
  if (exceptional !== undefined) return yield* Effect.failCause(exceptional);
  if (dependencyExit !== undefined) return { ok: false, dependencyExit };
  return {
    ok: result.outcome === "green",
    ...(lastExitCode === undefined ? {} : { lastExitCode }),
    ...(timedOut ? { timedOut: true } : {}),
    ...(lastError === undefined ? {} : { lastError }),
  };
});

export const runServiceStartSchedule = Effect.fn("RuntimeProvider.startSchedule")(function* <E, R>(
  plan: AppPlan,
  handlers: ServiceStartHandlers<E, R>,
): Effect.fn.Return<ServiceStartResult, E | HealthcheckTargetUnsupportedError | ServiceExecError, R> {
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
          return handlers.waitForExit(value.service).pipe(
            Effect.map((result) =>
              recordGateOutcome(node.id, {
                ok: result.exitCode === 0,
                ...(result.exitCode === undefined ? {} : { lastExitCode: result.exitCode }),
              }),
            ),
            Effect.catch(() => Effect.succeed(recordGateOutcome(node.id, { ok: false }))),
          );
      }
    },
  });

  if (settled._tag === "Cycle") return { _tag: "Cycle", edges: settled.edges };
  return { _tag: "Settled", changed, blocked };
});
