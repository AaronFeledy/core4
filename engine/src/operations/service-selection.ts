import { Effect, Graph } from "effect";

import { ServiceNotFoundError } from "@lando/sdk/errors";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";

const uniqueRequested = (requested: ReadonlyArray<ServiceName>): ReadonlyArray<ServiceName> => [
  ...new Map(requested.map((name) => [String(name), name])).values(),
];

const unknownService = (plan: AppPlan, service: ServiceName, requested: ReadonlyArray<ServiceName>) =>
  new ServiceNotFoundError({
    providerId: String(plan.provider),
    operation: "selectServices",
    service: String(service),
    message: `Service ${String(service)} is not defined in ${plan.name}.`,
    details: {
      requested: requested.map(String),
      available: Object.keys(plan.services),
    },
    remediation: `Choose one of: ${Object.keys(plan.services).join(", ")}.`,
  });

const filteredPlan = (plan: AppPlan, orderedNames: ReadonlyArray<string>): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    orderedNames.flatMap((name) => {
      const service = plan.services[ServiceName.make(name)];
      return service === undefined ? [] : [[service.name, service]];
    }),
  ),
  routes: plan.routes.filter((route) => orderedNames.includes(String(route.service))),
  fileSync: plan.fileSync.filter((entry) => orderedNames.includes(String(entry.session.service))),
});

const validateRequested = (
  plan: AppPlan,
  requested: ReadonlyArray<ServiceName> | undefined,
): Effect.Effect<ReadonlyArray<ServiceName>, ServiceNotFoundError> => {
  const unique = uniqueRequested(requested ?? []);
  const missing = unique.find((name) => !Object.hasOwn(plan.services, String(name)));
  return missing === undefined ? Effect.succeed(unique) : Effect.fail(unknownService(plan, missing, unique));
};

export const selectInfoPlan = (
  plan: AppPlan,
  requested: ReadonlyArray<ServiceName> | undefined,
): Effect.Effect<AppPlan, ServiceNotFoundError> =>
  validateRequested(plan, requested).pipe(
    Effect.map((unique) =>
      unique.length === 0
        ? plan
        : filteredPlan(
            plan,
            Object.values(plan.services)
              .map((service) => String(service.name))
              .filter((name) => unique.some((requestedName) => String(requestedName) === name)),
          ),
    ),
  );

export const selectRebuildPlan = (
  plan: AppPlan,
  requested: ReadonlyArray<ServiceName> | undefined,
): Effect.Effect<AppPlan, ServiceNotFoundError> =>
  validateRequested(plan, requested).pipe(
    Effect.map((unique) => {
      if (unique.length === 0) return plan;
      const indices = new Map<string, Graph.NodeIndex>();
      const graph = Graph.directed<string, void>((mutable) => {
        for (const service of Object.values(plan.services)) {
          indices.set(String(service.name), Graph.addNode(mutable, String(service.name)));
        }
        for (const service of Object.values(plan.services)) {
          const dependent = indices.get(String(service.name));
          if (dependent === undefined) continue;
          for (const dependency of service.dependsOn) {
            const predecessor = indices.get(String(dependency.service));
            if (predecessor !== undefined) Graph.addEdge(mutable, predecessor, dependent, undefined);
          }
        }
      });
      const closure = new Set(
        Graph.indices(
          Graph.dfs(graph, {
            start: unique.flatMap((name) => {
              const index = indices.get(String(name));
              return index === undefined ? [] : [index];
            }),
            direction: "incoming",
          }),
        ),
      );
      const pending = Graph.beginMutation(graph);
      for (const index of indices.values()) {
        if (!closure.has(index)) Graph.removeNode(pending, index);
      }
      const ordered: string[] = [];
      while (Graph.nodeCount(pending) > 0) {
        const before = ordered.length;
        for (const [index, name] of Graph.entries(Graph.nodes(pending))) {
          if (Graph.inDegree(pending, index) === 0) {
            ordered.push(name);
            Graph.removeNode(pending, index);
          }
        }
        if (ordered.length === before && !Graph.isAcyclic(pending)) break;
      }
      return filteredPlan(plan, ordered);
    }),
  );
