import {
  matchPublicationBindings,
  physicalPublicationIdentity,
} from "@lando/container-runtime/physical-publications";
import {
  type EndpointRef,
  type LogicalEndpoint,
  type ObservedPublication,
  type PublicationObservation,
  type RouteEvidence,
  type RoutePlan,
  type ServiceConnection,
  type ServicePlan,
  type ServiceState,
  groupLogicalEndpoints,
  logicalEndpointIdentity,
} from "@lando/sdk/schema";
import { connectionActivity } from "./connection-state.ts";
import { clientConnectionUrls, connectionHost, connectionUrl } from "./connection-url.ts";
import { projectRouteConnections } from "./route-connections.ts";

export { serviceState, connectionActivity } from "./connection-state.ts";

const endpointRef = ({ port, transport, names, primary }: LogicalEndpoint): EndpointRef => ({
  port,
  transport,
  names,
  primary,
});

export const observedPublicationConnection = (
  binding: ObservedPublication,
  state: ServiceState,
): ServiceConnection => {
  const host = connectionHost(binding.bindAddress);
  return {
    scope: "host",
    source: "publication",
    binding: "assigned",
    protocol: binding.transport,
    endpoint: { port: binding.port, transport: binding.transport, names: [], primary: false },
    host,
    port: binding.hostPort,
    state: connectionActivity(state),
    url: connectionUrl({ host, port: binding.hostPort, protocol: binding.transport }),
    alternateUrls: [],
  };
};

export const projectServiceConnections = (input: {
  readonly service: ServicePlan;
  readonly state: ServiceState;
  readonly publications: PublicationObservation;
  readonly routes: readonly RoutePlan[];
  readonly routeEvidence?: RouteEvidence;
  readonly routerEnabled?: boolean;
}): readonly ServiceConnection[] => {
  const { service, publications } = input;
  const groups = groupLogicalEndpoints(service.endpoints);
  const activity = connectionActivity(input.state);
  const absent = publications.status === "missing";
  const unobserved = activity === "inactive" || publications.status !== "unknown" ? "inactive" : "unknown";
  const bindings = publications.status === "present" ? publications.bindings : [];
  const publicationMatches = matchPublicationBindings(service.endpoints, bindings);
  const matched = new Set<ObservedPublication>();
  const connections: ServiceConnection[] = [];
  for (const group of groups) {
    const endpoint = endpointRef(group);
    const protocol = group.protocols.length === 1 ? (group.protocols[0] ?? group.transport) : group.transport;
    connections.push({
      scope: "app",
      source: "listener",
      endpoint,
      protocol,
      binding: "assigned",
      host: String(service.name),
      port: group.port,
      state: absent ? "inactive" : activity,
      ...clientConnectionUrls({ service, endpoint, protocol, host: String(service.name), port: group.port }),
    });
    for (const facet of service.endpoints) {
      if (facet._tag !== "published" || logicalEndpointIdentity(facet) !== logicalEndpointIdentity(group))
        continue;
      const address = facet.publication.bindAddress ?? "127.0.0.1";
      const actual = publicationMatches.get(physicalPublicationIdentity(facet)) ?? [];
      for (const binding of actual) {
        matched.add(binding);
        const host = connectionHost(binding.bindAddress);
        connections.push({
          scope: "host",
          source: "publication",
          endpoint,
          protocol,
          binding: "assigned",
          host,
          port: binding.hostPort,
          state: activity,
          ...clientConnectionUrls({ service, endpoint, protocol, host, port: binding.hostPort }),
        });
      }
      if (actual.length > 0) continue;
      const host = connectionHost(address);
      const port = facet.publication.hostPort;
      connections.push(
        port === undefined
          ? {
              scope: "host",
              source: "publication",
              endpoint,
              protocol,
              binding: "pending",
              host,
              state: unobserved,
            }
          : {
              scope: "host",
              source: "publication",
              endpoint,
              protocol,
              binding: "assigned",
              host,
              port,
              state: unobserved,
              ...clientConnectionUrls({ service, endpoint, protocol, host, port }),
            },
      );
    }
  }
  for (const binding of bindings) {
    if (matched.has(binding)) continue;
    connections.push(observedPublicationConnection(binding, input.state));
  }
  connections.push(...projectRouteConnections({ ...input, groups }));
  return [
    ...new Map(
      connections.map((row) => [
        `${row.scope}/${row.source}/${logicalEndpointIdentity(row.endpoint)}/${row.protocol}/${row.host}/${row.binding === "assigned" ? row.port : "pending"}/${row.source === "route" ? row.pathPrefix : ""}`,
        row,
      ]),
    ).values(),
  ];
};

export const activeHostHttpUrls = (connections: readonly ServiceConnection[]): readonly string[] => [
  ...new Set(
    connections.flatMap((connection) =>
      connection.scope === "host" &&
      connection.binding === "assigned" &&
      connection.state === "active" &&
      (connection.protocol === "http" || connection.protocol === "https") &&
      !connection.host.includes("*") &&
      !URL.parse(connection.url)?.hostname.includes("*")
        ? [connection.url]
        : [],
    ),
  ),
];
