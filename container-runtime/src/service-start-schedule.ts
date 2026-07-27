import { Duration, Effect } from "effect";

import { runProbe } from "@lando/sdk/probe";
import type { AppPlan, HealthcheckPlan, ServiceDependencyCondition, ServicePlan } from "@lando/sdk/schema";

import { gateId, gateNodeId } from "./dependency-gates.ts";
import { type ScheduleEdge, type ScheduleGraph, runDependencySchedule } from "./dependency-schedule.ts";

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
}

export type ServiceStartResult =
  | { readonly _tag: "Cycle"; readonly edges: ReadonlyArray<string> }
  | {
      readonly _tag: "Settled";
      readonly changed: boolean;
      readonly blocked: ReadonlyArray<BlockedService>;
    };

export interface ServiceStartHandlers<E, R> {
  /** Brings one service up. A failure here is a hard error that aborts the schedule. */
  readonly startService: (service: ServicePlan) => Effect.Effect<{ readonly changed: boolean }, E, R>;
  /** Reverts only one optional-only service after its tolerated start failure. */
  readonly cleanupOptionalStartFailure?: (service: ServicePlan) => Effect.Effect<void, never, R>;
  /** Runs one healthcheck attempt inside the service. */
  readonly execHealthcheck: (
    service: ServicePlan,
    command: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly exitCode: number }, unknown, R>;
  /** Waits for a one-shot service to exit. */
  readonly waitForExit: (service: ServicePlan) => Effect.Effect<{ readonly exitCode: number }, unknown, R>;
}

/** The schedule node id that starts `service`. */
export const serviceStartNodeId = (service: string): string => `svc:${service}`;

/**
 * Only `kind: "command"` healthchecks are verifiable through the provider exec
 * channel. Every other shape fails closed.
 */
const gateVerifiableCommand = (
  healthcheck: HealthcheckPlan | undefined,
): ReadonlyArray<string> | undefined => {
  if (healthcheck === undefined || healthcheck.kind !== "command") return undefined;
  const command = healthcheck.command;
  if (command === undefined) return undefined;
  return typeof command === "string" ? ["sh", "-c", command] : [...command];
};

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

const probeHealthy = <E, R>(
  service: ServicePlan,
  handlers: ServiceStartHandlers<E, R>,
): Effect.Effect<boolean, never, R> =>
  Effect.gen(function* () {
    const healthcheck = service.healthcheck;
    const command = gateVerifiableCommand(healthcheck);
    if (healthcheck === undefined || command === undefined) return false;

    if (healthcheck.startPeriodSeconds !== undefined && healthcheck.startPeriodSeconds > 0) {
      yield* Effect.sleep(Duration.seconds(healthcheck.startPeriodSeconds));
    }

    const attempt = Effect.timeoutTo(Effect.either(handlers.execHealthcheck(service, command)), {
      duration: Duration.seconds(healthcheck.timeoutSeconds),
      onSuccess: (result) => (result._tag === "Right" && result.right.exitCode === 0 ? "green" : "red"),
      onTimeout: () => "red" as const,
    });

    return yield* runProbe(
      {
        id: `service-start-health:${String(service.name)}`,
        policy: {
          maxAttempts: Math.max(1, healthcheck.retries),
          delay: Duration.seconds(healthcheck.intervalSeconds),
          backoff: "fixed",
        },
        classify: {
          success: (value) => (value === "green" ? "green" : "red"),
          failure: () => "red",
        },
      },
      attempt,
    ).pipe(
      Effect.map((result) => result.outcome === "green"),
      Effect.catchAll(() => Effect.succeed(false)),
    );
  });

export const runServiceStartSchedule = <E, R>(
  plan: AppPlan,
  handlers: ServiceStartHandlers<E, R>,
): Effect.Effect<ServiceStartResult, E, R> =>
  Effect.gen(function* () {
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
    let changed = false;

    const settled = yield* runDependencySchedule(graph, {
      concurrency: 1,
      run: (node, blockedBy) => {
        const value = node.value;
        const [unmetGate] = blockedBy;
        if (unmetGate !== undefined) {
          if (value._tag === "service") {
            const unmet = nodeById.get(unmetGate);
            blocked.push({
              service: String(value.service.name),
              unmetGate:
                unmet?._tag === "gate" ? gateId(String(unmet.service.name), unmet.condition) : unmetGate,
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
            ? start.pipe(
                Effect.catchAll(() =>
                  (handlers.cleanupOptionalStartFailure?.(value.service) ?? Effect.void).pipe(
                    Effect.as("failed" as const),
                  ),
                ),
              )
            : start;
        }
        switch (value.condition) {
          case "service_started":
            return Effect.succeed("succeeded" as const);
          case "service_healthy":
            return probeHealthy(value.service, handlers).pipe(
              Effect.map((healthy) => (healthy ? ("succeeded" as const) : ("failed" as const))),
            );
          case "service_completed_successfully":
            return handlers.waitForExit(value.service).pipe(
              Effect.map((result) => (result.exitCode === 0 ? ("succeeded" as const) : ("failed" as const))),
              Effect.catchAll(() => Effect.succeed("failed" as const)),
            );
        }
      },
    });

    if (settled._tag === "Cycle") return { _tag: "Cycle", edges: settled.edges };
    return { _tag: "Settled", changed, blocked };
  });
