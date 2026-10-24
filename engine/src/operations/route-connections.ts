import type {
  EndpointRef,
  LogicalEndpoint,
  RouteEvidence,
  RoutePlan,
  ServiceConnection,
  ServicePlan,
  ServiceState,
} from "@lando/sdk/schema";
import { connectionActivity } from "./connection-state.ts";
import { connectionHost, connectionUrl } from "./connection-url.ts";

const matchesRoute = (left: RoutePlan, right: RoutePlan): boolean =>
  left.hostname.toLowerCase() === right.hostname.toLowerCase() &&
  left.scheme === right.scheme &&
  (left.pathPrefix ?? "") === (right.pathPrefix ?? "") &&
  left.service === right.service &&
  left.backend.service === right.backend.service &&
  left.backend.port === right.backend.port &&
  left.backend.protocol === right.backend.protocol &&
  left.backend.host === right.backend.host;

export const projectRouteConnections = (input: {
  readonly service: ServicePlan;
  readonly state: ServiceState;
  readonly routes: readonly RoutePlan[];
  readonly groups: readonly LogicalEndpoint[];
  readonly routeEvidence?: RouteEvidence;
  readonly routerEnabled?: boolean;
}): readonly ServiceConnection[] => {
  const connections: ServiceConnection[] = [];
  const observation = input.routeEvidence?.observation;
  const activity = connectionActivity(input.state);
  const inactive =
    input.routerEnabled === false || activity === "inactive" || observation?.status === "missing";
  const unobserved = inactive || observation?.status === "present" ? "inactive" : "unknown";
  for (const route of input.routes.filter((route) => route.service === input.service.name)) {
    const group = input.groups.find(
      (group) => group.port === route.backend.port && group.transport === "tcp",
    );
    const endpoint: EndpointRef = {
      port: route.backend.port,
      transport: "tcp",
      names: group?.names ?? [],
      primary: group?.primary ?? false,
    };
    const schemes = route.scheme === "both" ? (["http", "https"] as const) : [route.scheme];
    for (const protocol of schemes) {
      const configured =
        input.routeEvidence?.configuredAuthorities.filter(
          (authority) =>
            authority.hostname.toLowerCase() === route.hostname.toLowerCase() &&
            authority.scheme === protocol,
        ) ?? [];
      const observed =
        observation?.status === "present"
          ? observation.publications
              .filter(
                (publication) =>
                  matchesRoute(route, publication.route) &&
                  publication.authority.hostname.toLowerCase() === route.hostname.toLowerCase() &&
                  publication.authority.scheme === protocol,
              )
              .map((publication) => publication.authority)
          : [];
      const authorities = [
        ...new Map([...configured, ...observed].map((authority) => [authority.port, authority])).values(),
      ];
      const common = {
        scope: "host",
        source: "route",
        endpoint,
        protocol,
        host: connectionHost(route.hostname),
        pathPrefix: route.pathPrefix ?? "",
      } as const;
      if (authorities.length === 0) {
        connections.push({
          ...common,
          binding: "pending",
          state: unobserved,
        });
      }
      for (const authority of authorities) {
        connections.push({
          ...common,
          binding: "assigned",
          port: authority.port,
          url: connectionUrl({
            host: route.hostname,
            port: authority.port,
            protocol,
            pathPrefix: route.pathPrefix ?? "",
          }),
          alternateUrls: [],
          state:
            !inactive && observed.some((actual) => actual.port === authority.port) ? activity : unobserved,
        });
      }
    }
  }
  return connections;
};
