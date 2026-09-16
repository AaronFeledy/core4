import { Effect } from "effect";

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
      const closure = new Set(unique.map((name) => String(name)));
      const pending = [...unique];
      while (pending.length > 0) {
        const name = pending.shift();
        if (name === undefined) continue;
        const service = Object.hasOwn(plan.services, String(name)) ? plan.services[name] : undefined;
        if (service === undefined) continue;
        for (const dependency of service.dependsOn) {
          const dependencyName = String(dependency.service);
          if (!Object.hasOwn(plan.services, dependencyName) || closure.has(dependencyName)) continue;
          closure.add(dependencyName);
          pending.push(dependency.service);
        }
      }

      const ordered = new Set<string>();
      while (ordered.size < closure.size) {
        const before = ordered.size;
        for (const service of Object.values(plan.services)) {
          const name = String(service.name);
          if (!closure.has(name) || ordered.has(name)) continue;
          const waiting = service.dependsOn.some(
            (dependency) =>
              closure.has(String(dependency.service)) && !ordered.has(String(dependency.service)),
          );
          if (!waiting) ordered.add(name);
        }
        if (ordered.size === before) break;
      }
      return filteredPlan(plan, [...ordered]);
    }),
  );
