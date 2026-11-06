import { Effect } from "effect";

import type { HealthcheckTargetUnsupportedError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type HealthcheckPlan,
  type ServiceDependencyCondition,
  type ServicePlan,
  effectiveReadiness,
  probeTargetError,
} from "@lando/sdk/schema";

import { gateId, gateNodeId } from "./dependency-gates.ts";
import { type ScheduleEdge, type ScheduleGraph, runDependencySchedule } from "./dependency-schedule.ts";
import { runHealthcheckProbe } from "./healthcheck-probe.ts";

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
  /** Waits for a one-shot service to exit. */
  readonly waitForExit: (service: ServicePlan) => Effect.Effect<{ readonly exitCode: number }, unknown, R>;
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
}

const probeHealthy = Effect.fnUntraced(function* <E, R>(
  service: ServicePlan,
  handlers: ServiceStartHandlers<E, R>,
): Effect.fn.Return<GateProbeResult, never, R> {
  const healthcheck = effectiveReadiness(service);
  if (healthcheck === undefined || healthcheck.kind !== "command" || healthcheck.command === undefined)
    return { ok: false };

  let lastExitCode: number | undefined;
  let timedOut = false;
  let lastError: string | undefined;
  const attempt = Effect.gen(function* () {
    const result = yield* Effect.result(handlers.execHealthcheck(service, healthcheck));
    timedOut = false;
    if (result._tag === "Success") {
      lastError =
        result.success.exitCode === 0 || !result.success.stderr
          ? undefined
          : (handlers.redactProbeError?.(result.success.stderr) ?? "Readiness command failed.").slice(
              0,
              2048,
            );
      lastExitCode = result.success.exitCode;
      return result.success.exitCode === 0 ? "green" : "red";
    }
    lastExitCode = undefined;
    lastError = (
      handlers.redactProbeError?.(result.failure) ?? "Readiness attempt infrastructure failure."
    ).slice(0, 2048);
    return "red";
  });
  const ok = yield* runHealthcheckProbe(
    { id: `service-start-health:${String(service.name)}`, plan: healthcheck },
    attempt,
    Effect.sync(() => {
      timedOut = true;
      return "red" as const;
    }),
  ).pipe(
    Effect.map((result) => result.outcome === "green"),
    Effect.catch(() => Effect.succeed(false)),
  );
  return {
    ok,
    ...(lastExitCode === undefined ? {} : { lastExitCode }),
    ...(timedOut ? { timedOut: true } : {}),
    ...(lastError === undefined ? {} : { lastError }),
  };
});

export const runServiceStartSchedule = Effect.fn("RuntimeProvider.startSchedule")(function* <E, R>(
  plan: AppPlan,
  handlers: ServiceStartHandlers<E, R>,
): Effect.fn.Return<ServiceStartResult, E | HealthcheckTargetUnsupportedError, R> {
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
  const gateOutcomes = new Map<string, Pick<BlockedService, "lastExitCode" | "timedOut" | "lastError">>();
  let changed = false;

  const recordGateOutcome = (nodeId: string, outcome: GateProbeResult): "succeeded" | "failed" => {
    gateOutcomes.set(nodeId, {
      ...(outcome.lastExitCode === undefined ? {} : { lastExitCode: outcome.lastExitCode }),
      ...(outcome.timedOut === true ? { timedOut: true } : {}),
      ...(outcome.lastError === undefined ? {} : { lastError: outcome.lastError }),
    });
    return outcome.ok ? "succeeded" : "failed";
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
              recordGateOutcome(node.id, { ok: result.exitCode === 0, lastExitCode: result.exitCode }),
            ),
            Effect.catch(() => Effect.succeed(recordGateOutcome(node.id, { ok: false }))),
          );
      }
    },
  });

  if (settled._tag === "Cycle") return { _tag: "Cycle", edges: settled.edges };
  return { _tag: "Settled", changed, blocked };
});
