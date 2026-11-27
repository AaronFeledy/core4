import { routerEnabled } from "@lando/engine/config/router-config";
import { collectPlanConnections } from "@lando/engine/operations/connection-collector";
import { type AppPlan, type StartedService, isWildcardHostname } from "@lando/sdk/schema";
import { Effect } from "effect";

import { type OpenTargetSelection, defaultHttpListeners, resolveOpenTargets } from "./open-targets";

export const collectOpenConnections = Effect.fn("OpenApp.collectConnections")(function* (
  plan: AppPlan,
  selection: OpenTargetSelection,
) {
  const routes = plan.routes.filter((route) => routerEnabled(plan) && !isWildcardHostname(route.hostname));
  const services = Object.fromEntries(
    Object.entries(plan.services).filter(([, service]) => {
      if (selection.service !== undefined && service.name !== selection.service) return false;
      if (selection.all === true)
        return (
          service.endpoints.some(
            (endpoint) => endpoint.protocol === "http" || endpoint.protocol === "https",
          ) || routes.some((route) => route.service === service.name)
        );
      return defaultHttpListeners(service.endpoints, service.certs !== undefined).length > 0;
    }),
  );
  if (Object.keys(services).length === 0) return [];
  const entries = Object.entries(services);
  const collect = (entry: (typeof entries)[number]) =>
    collectPlanConnections(
      {
        ...plan,
        services: Object.fromEntries([entry]),
        routes: routes.filter((route) => route.service === entry[1].name),
      },
      undefined,
      plan,
    );
  if (selection.service === undefined && selection.all !== true) {
    const observed: StartedService[] = [];
    for (const entry of entries) {
      const listeners = defaultHttpListeners(entry[1].endpoints, entry[1].certs !== undefined);
      if (
        !routes.some(
          (route) =>
            route.service === entry[1].name &&
            listeners.some(
              (listener) => listener.transport === "tcp" && listener.port === route.backend.port,
            ),
        )
      )
        continue;
      const rows = yield* collect(entry);
      observed.push(...rows);
      const routeRows = rows.map((row) => ({ ...row, connections: [] }));
      if (resolveOpenTargets(plan, selection, routeRows).length > 0) return rows;
    }
    for (const entry of entries) {
      const cached = observed.filter((row) => row.name === entry[1].name);
      const rows = cached.length > 0 ? cached : yield* collect(entry);
      if (resolveOpenTargets(plan, selection, rows).length > 0) return rows;
    }
    return observed;
  }
  return yield* collectPlanConnections(
    { ...plan, services, routes: routes.filter((route) => Object.hasOwn(services, route.service)) },
    undefined,
    plan,
  );
});
