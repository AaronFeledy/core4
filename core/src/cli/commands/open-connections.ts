import { routerEnabled } from "@lando/engine/config/router-config";
import { collectPlanConnections } from "@lando/engine/operations/connection-collector";
import type { AppPlan, StartedService } from "@lando/sdk/schema";
import { selectHttpEndpoint } from "@lando/sdk/schema";
import { Effect } from "effect";

import { type OpenTargetSelection, resolveOpenTargets } from "./open-targets";

export const collectOpenConnections = Effect.fn("OpenApp.collectConnections")(function* (
  plan: AppPlan,
  selection: OpenTargetSelection,
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
      return selectHttpEndpoint(service.endpoints).status === "selected";
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
  if (selection.service === undefined && selection.route === undefined && selection.all !== true) {
    const observed: StartedService[] = [];
    for (const entry of entries) {
      const listener = selectHttpEndpoint(entry[1].endpoints);
      switch (listener.status) {
        case "none":
        case "ambiguous":
          continue;
        case "selected":
          break;
        default: {
          const unreachable: never = listener;
          return unreachable;
        }
      }
      if (
        !routes.some(
          (route) =>
            route.service === entry[1].name &&
            route.backend.port === listener.endpoint.port &&
            listener.endpoint.transport === "tcp",
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
  return yield* collectPlanConnections(
    { ...plan, services, routes: routes.filter((route) => Object.hasOwn(services, route.service)) },
    undefined,
    plan,
  );
});
