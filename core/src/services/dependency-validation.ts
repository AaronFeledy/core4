import { Effect, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { type AppPlan, DependencyPlan, HealthcheckPlan } from "@lando/sdk/schema";

const DependencyServicePlan = Schema.Struct({
  dependsOn: Schema.Array(DependencyPlan),
  healthcheck: Schema.optional(HealthcheckPlan),
});

const DependencyServicePlans = Schema.Record({
  key: Schema.String,
  value: DependencyServicePlan,
});

type DependencyCycle = {
  readonly dependentName: string;
  readonly serviceNames: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<typeof DependencyPlan.Type>;
};

const ownService = <T>(services: Readonly<Record<string, T>>, name: string): T | undefined =>
  Object.hasOwn(services, name) ? services[name] : undefined;

export const validateServiceDependencies = (
  appRoot: string,
  services: AppPlan["services"] | Readonly<Record<string, unknown>>,
): Effect.Effect<void, LandofileValidationError> =>
  Effect.gen(function* () {
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
                issues: [`services.${dependentName}.dependsOn`],
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
              issues: [`services.${dependentName}.dependsOn`],
            }),
          );
        }
      }
    }

    const visited = new Set<string>();
    const activeIndexes = new Map<string, number>();
    const pathServiceNames: Array<string> = [];
    const pathDependencies: Array<typeof DependencyPlan.Type> = [];

    const findCycle = (serviceName: string): DependencyCycle | undefined => {
      activeIndexes.set(serviceName, pathServiceNames.length);
      pathServiceNames.push(serviceName);

      const servicePlan = ownService(servicePlans, serviceName);
      if (servicePlan !== undefined) {
        for (const dependency of servicePlan.dependsOn) {
          const targetName = String(dependency.service);
          if (ownService(servicePlans, targetName) === undefined) continue;

          const activeIndex = activeIndexes.get(targetName);
          if (activeIndex !== undefined) {
            return {
              dependentName: serviceName,
              serviceNames: pathServiceNames.slice(activeIndex),
              dependencies: [...pathDependencies.slice(activeIndex), dependency],
            };
          }
          if (visited.has(targetName)) continue;

          pathDependencies.push(dependency);
          const cycle = findCycle(targetName);
          if (cycle !== undefined) return cycle;
          pathDependencies.pop();
        }
      }

      pathServiceNames.pop();
      activeIndexes.delete(serviceName);
      visited.add(serviceName);
      return undefined;
    };

    for (const serviceName of Object.keys(servicePlans)) {
      if (visited.has(serviceName)) continue;
      const cycle = findCycle(serviceName);
      if (cycle === undefined) continue;

      const firstServiceName = cycle.serviceNames[0];
      if (firstServiceName === undefined) continue;
      const description = cycle.dependencies.reduce(
        (current, dependency, index) =>
          `${current} --[${dependency.condition}]--> ${cycle.serviceNames[index + 1] ?? firstServiceName}`,
        firstServiceName,
      );
      return yield* Effect.fail(
        new LandofileValidationError({
          message: `Dependency cycle detected: ${description}. Remove or redirect one dependency edge; required: false does not break a dependency cycle.`,
          file: `${appRoot}/.lando.yml`,
          issues: [`services.${cycle.dependentName}.dependsOn`],
        }),
      );
    }
  });
