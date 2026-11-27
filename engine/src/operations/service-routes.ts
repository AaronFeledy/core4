import {
  type EndpointRef,
  type RouteEvidence,
  type RoutePlan,
  type ServicePlan,
  type ServiceRoute,
  type ServiceState,
  groupLogicalEndpoints,
  logicalEndpointIdentity,
} from "@lando/sdk/schema";
import { routeExecutionKey } from "../planner/route-identity.ts";
import { connectionActivity } from "./connection-state.ts";
import { primaryConcreteRoute, routeAddress, routeHost, routeUrlScheme } from "./connection-url.ts";

type RoutePublication = Extract<RouteEvidence["observation"], { status: "present" }>["publications"][number];

export const matchesRoutePublication = (route: RoutePlan, publication: RoutePublication): boolean => {
  const { route: published, authority } = publication;
  const hostname = route.hostname.toLowerCase();
  return (
    hostname === published.hostname.toLowerCase() &&
    hostname === authority.hostname.toLowerCase() &&
    (route.scheme === "both" || route.scheme === authority.scheme) &&
    route.scheme === published.scheme &&
    (route.pathPrefix ?? "") === (published.pathPrefix ?? "") &&
    route.priority === published.priority &&
    route.service === published.service &&
    routeExecutionKey(route) === routeExecutionKey(published)
  );
};

export const projectServiceRoutes = (input: {
  readonly service: ServicePlan;
  readonly state: ServiceState;
  readonly routes: readonly RoutePlan[];
  readonly routeEvidence?: RouteEvidence;
  readonly routerEnabled?: boolean;
}): readonly ServiceRoute[] => {
  const rows: ServiceRoute[] = [];
  const groups = groupLogicalEndpoints(input.service.endpoints);
  const observation = input.routeEvidence?.observation;
  const activity = connectionActivity(input.state);
  const inactive =
    input.routerEnabled === false || activity === "inactive" || observation?.status === "missing";
  const unobserved = inactive || observation?.status === "present" ? "inactive" : "unknown";
  for (const route of input.routes.filter((route) => route.service === input.service.name)) {
    const group = groups.find((group) => group.port === route.backend.port && group.transport === "tcp");
    const endpoint: EndpointRef = {
      port: route.backend.port,
      transport: "tcp",
      names: group?.names ?? [],
      primary: group?.primary ?? false,
    };
    const schemes = route.scheme === "both" ? (["http", "https"] as const) : [route.scheme];
    for (const protocol of schemes) {
      const host = route.hostname.toLowerCase();
      const ports = new Set<number>();
      for (const authority of input.routeEvidence?.configuredAuthorities ?? []) {
        if (authority.scheme === protocol && authority.hostname.toLowerCase() === host)
          ports.add(authority.port);
      }
      const observedPorts = new Set<number>();
      if (observation?.status === "present") {
        for (const publication of observation.publications) {
          const { authority } = publication;
          if (authority.scheme === protocol && matchesRoutePublication(route, publication)) {
            ports.add(authority.port);
            observedPorts.add(authority.port);
          }
        }
      }
      if (ports.size === 0) {
        rows.push({
          endpoint,
          ...routeHost(route, protocol),
          binding: "pending",
          state: unobserved,
        });
      }
      for (const port of ports) {
        rows.push({
          ...routeAddress(route, protocol, port),
          endpoint,
          binding: "assigned",
          state: !inactive && observedPorts.has(port) ? activity : unobserved,
        });
      }
    }
  }
  return [
    ...new Map(
      rows.map((row) => [
        `${logicalEndpointIdentity(row.endpoint)}/${row.protocol}/${row.host}/${row.binding === "assigned" ? row.port : "pending"}/${row.pathPrefix}`,
        row,
      ]),
    ).values(),
  ];
};

/**
 * The public URL `{{ services.<name>.url }}` names: the service's primary concrete route in `routes`
 * (the applied route table when one exists), read from the assigned route already
 * projected for it. Undefined when the service has no concrete route or the router reports no
 * authority for that route.
 */
export const primaryRouteUrl = (
  routes: readonly RoutePlan[],
  service: string,
  reported: readonly ServiceRoute[],
): string | undefined => {
  const route = primaryConcreteRoute(routes, service);
  if (route === undefined) return undefined;
  const scheme = routeUrlScheme(route);
  const host = route.hostname.toLowerCase();
  const pathPrefix = route.pathPrefix ?? "";
  for (const row of reported) {
    if (
      row.binding === "assigned" &&
      row.hostMatch === "exact" &&
      row.protocol === scheme &&
      row.host === host &&
      row.pathPrefix === pathPrefix
    )
      return row.url;
  }
  return undefined;
};
