import { routerEnabled } from "@lando/engine/config/router-config";
import {
  collectPlanConnections,
  collectPlanObservations,
} from "@lando/engine/operations/connection-collector";
import type { AppPlan, StartedService } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";

import { type OpenTargetSelection, defaultHttpListeners, resolveOpenTargets } from "./open-targets";

export const collectOpenConnections = Effect.fn("OpenApp.collectConnections")(function* (
  plan: AppPlan,
  selection: OpenTargetSelection,
  provider?: RuntimeProviderShape,
) {
  const routes = plan.routes.filter(
    (route) =>
      routerEnabled(plan) &&
      !route.hostname.includes("*") &&
      (selection.route === undefined || route.hostname === selection.route),
  );
  const services = Object.fromEntries(
    Object.entries(plan.services).filter(([, service]) => {
      if (selection.route !== undefined) return routes.some((route) => route.service === service.name);
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
  // One provider observation per candidate plan, so a caller that already admitted the app
  // never constructs the provider a second time.
  const collectPlan = Effect.fnUntraced(function* (candidate: AppPlan) {
    const observations = yield* collectPlanObservations(candidate, plan, provider);
    return yield* collectPlanConnections(candidate, observations);
  });
  const collect = (entry: (typeof entries)[number]) =>
    collectPlan({
      ...plan,
      services: Object.fromEntries([entry]),
      routes: routes.filter((route) => route.service === entry[1].name),
    });
  if (selection.service === undefined && selection.route === undefined && selection.all !== true) {
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
      const routeRows = rows.map((row) => ({
        ...row,
        connections: row.connections.filter((connection) => connection.source === "route"),
      }));
      if (resolveOpenTargets(plan, selection, routeRows).length > 0) return rows;
    }
    for (const entry of entries) {
      const cached = observed.filter((row) => row.name === entry[1].name);
      const rows = cached.length > 0 ? cached : yield* collect(entry);
      if (resolveOpenTargets(plan, selection, rows).length > 0) return rows;
    }
    return observed;
  }
  return yield* collectPlan({
    ...plan,
    services,
    routes: routes.filter((route) => Object.hasOwn(services, route.service)),
  });
});
