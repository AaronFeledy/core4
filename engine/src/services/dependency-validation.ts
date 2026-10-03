import { Effect, Graph, Option, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { type AppPlan, DependencyPlan, HealthcheckPlan } from "@lando/sdk/schema";
import { validationIssueFromText } from "@lando/sdk/schema";

const DependencyServicePlan = Schema.Struct({
  dependsOn: Schema.Array(DependencyPlan),
  healthcheck: Schema.optionalKey(HealthcheckPlan),
});

const DependencyServicePlans = Schema.Record(Schema.String, DependencyServicePlan);

const ownService = <T>(services: Readonly<Record<string, T>>, name: string): T | undefined =>
  Object.hasOwn(services, name) ? services[name] : undefined;

export const validateServiceDependencies = Effect.fn("AppPlanner.validateDependencies")(function* (
  appRoot: string,
  services: AppPlan["services"] | Readonly<Record<string, unknown>>,
): Effect.fn.Return<void, LandofileValidationError> {
  const servicePlans = Schema.decodeUnknownSync(DependencyServicePlans)(services);

  for (const [dependentName, servicePlan] of Object.entries(servicePlans)) {
    for (const dependency of servicePlan.dependsOn) {
      const targetName = String(dependency.service);
      const target = ownService(servicePlans, targetName);
      if (target === undefined) {
        if (dependency.required) {
          return yield* Effect.fail(
            new LandofileValidationError({
              message: `Service ${dependentName} depends on missing service ${targetName} with condition ${dependency.condition}. Add service ${targetName} to services or set required: false on this dependency.`,
              file: `${appRoot}/.lando.yml`,
              issues: [
                validationIssueFromText(
                  `services.${dependentName}.dependsOn`,
                  `Service ${dependentName} depends on missing service ${targetName} with condition ${dependency.condition}. Add service ${targetName} to services or set required: false on this dependency.`,
                ),
              ],
            }),
          );
        }
        continue;
      }

      if (
        dependency.condition === "service_healthy" &&
        (target.healthcheck === undefined || target.healthcheck.kind === "none")
      ) {
        return yield* Effect.fail(
          new LandofileValidationError({
            message: `Service ${dependentName} depends on service ${targetName} with condition service_healthy, but service ${targetName} has no enabled healthcheck. Add a healthcheck with kind: command to service ${targetName}, or relax the dependency condition to service_started. Setting required: false only allows the dependency to be missing or fail; it does not make an unsatisfiable condition valid.`,
            file: `${appRoot}/.lando.yml`,
            issues: [
              validationIssueFromText(
                `services.${dependentName}.dependsOn`,
                `Service ${dependentName} depends on service ${targetName} with condition service_healthy, but service ${targetName} has no enabled healthcheck. Add a healthcheck with kind: command to service ${targetName}, or relax the dependency condition to service_started. Setting required: false only allows the dependency to be missing or fail; it does not make an unsatisfiable condition valid.`,
              ),
            ],
          }),
        );
      }
    }
  }

  const indices = new Map<string, Graph.NodeIndex>();
  const graph = Graph.directed<string, typeof DependencyPlan.Type>((mutable) => {
    for (const name of Object.keys(servicePlans)) indices.set(name, Graph.addNode(mutable, name));
    for (const [name, servicePlan] of Object.entries(servicePlans)) {
      const dependent = indices.get(name);
      if (dependent === undefined) continue;
      for (const dependency of servicePlan.dependsOn) {
        const target = indices.get(String(dependency.service));
        if (target !== undefined) Graph.addEdge(mutable, dependent, target, dependency);
      }
    }
  });
  const cycle = Graph.findCycle(graph);
  if (Option.isSome(cycle)) {
    const serviceNames = cycle.value.path.map((index) => Option.getOrThrow(Graph.getNode(graph, index)));
    const edges = cycle.value.edges.map((index) => Option.getOrThrow(Graph.getEdge(graph, index)));
    const firstServiceName = serviceNames[0];
    const closingEdge = edges.at(-1);
    if (firstServiceName === undefined || closingEdge === undefined) return;
    const dependentName = Option.getOrThrow(Graph.getNode(graph, closingEdge.source));
    const description = edges.reduce(
      (current, edge, index) =>
        `${current} --[${edge.data.condition}]--> ${serviceNames[index + 1] ?? firstServiceName}`,
      firstServiceName,
    );
    return yield* Effect.fail(
      new LandofileValidationError({
        message: `Dependency cycle detected: ${description}. Remove or redirect one dependency edge; required: false does not break a dependency cycle.`,
        file: `${appRoot}/.lando.yml`,
        issues: [
          validationIssueFromText(
            `services.${dependentName}.dependsOn`,
            `Dependency cycle detected: ${description}. Remove or redirect one dependency edge; required: false does not break a dependency cycle.`,
          ),
        ],
      }),
    );
  }
});
