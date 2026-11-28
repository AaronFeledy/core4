import {
  matchPublicationBindings,
  physicalPublicationIdentity,
} from "@lando/container-runtime/physical-publications";
import {
  type AppPlan,
  type EndpointRef,
  type LogicalEndpoint,
  type ObservedPublication,
  type PublicationObservation,
  type ServiceConnection,
  type ServicePlan,
  type ServiceRoute,
  type ServiceState,
  type StartedService,
  groupLogicalEndpoints,
  logicalEndpointIdentity,
  serviceListenerTarget,
} from "@lando/sdk/schema";
import { Result } from "effect";
import { connectionActivity } from "./connection-state.ts";
import { clientConnectionUrls, connectionHost, connectionUrl } from "./connection-url.ts";

export { connectionActivity, serviceStateOf } from "./connection-state.ts";

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
  readonly plan: Pick<AppPlan, "slug" | "networking">;
  readonly service: ServicePlan;
  readonly state: ServiceState;
  readonly publications: PublicationObservation;
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
    const target = serviceListenerTarget(input.plan, service, endpoint);
    if (Result.isSuccess(target))
      connections.push({
        scope: "app",
        source: "listener",
        endpoint,
        protocol,
        binding: "assigned",
        host: target.success.host,
        port: group.port,
        state: absent ? "inactive" : activity,
        ...clientConnectionUrls({ service, endpoint, protocol, host: target.success.host, port: group.port }),
      });
    for (const facet of service.endpoints) {
      if (facet.kind !== "published" || logicalEndpointIdentity(facet) !== logicalEndpointIdentity(group))
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
  return [
    ...new Map(
      connections.map((row) => [
        `${row.scope}/${row.source}/${logicalEndpointIdentity(row.endpoint)}/${row.protocol}/${row.host}/${row.binding === "assigned" ? row.port : "pending"}`,
        row,
      ]),
    ).values(),
  ];
};

type ServiceAddresses = Pick<StartedService, "connections" | "routes">;

/** One URL a browser on the host can open for a service: a published HTTP(S) port or an exact route. */
interface HostHttpAddress {
  readonly via: "publication" | "route";
  readonly url: string;
  readonly host: string;
  readonly protocol: "http" | "https";
  readonly pathPrefix: string;
  readonly endpoint: EndpointRef;
}

type AddressedRoute = Extract<ServiceRoute, { readonly url: string }>;
export const isAddressedRoute = (route: ServiceRoute): route is AddressedRoute =>
  route.binding === "assigned" && route.hostMatch === "exact";

/** Assigned, active, host HTTP(S) addresses: publications first, then exact routes, in reported order. */
export const activeHostHttpAddresses = (service: ServiceAddresses): readonly HostHttpAddress[] => [
  ...service.connections.flatMap<HostHttpAddress>((connection) => {
    if (
      connection.scope !== "host" ||
      connection.binding !== "assigned" ||
      connection.state !== "active" ||
      (connection.protocol !== "http" && connection.protocol !== "https")
    )
      return [];
    const { url, host, protocol, endpoint } = connection;
    return [{ via: "publication", url, host, protocol, endpoint, pathPrefix: "" }];
  }),
  ...service.routes.flatMap<HostHttpAddress>((route) => {
    if (!isAddressedRoute(route) || route.state !== "active") return [];
    const { url, host, protocol, endpoint, pathPrefix } = route;
    return [{ via: "route", url, host, protocol, endpoint, pathPrefix }];
  }),
];

export const activeHostHttpUrls = (service: ServiceAddresses): readonly string[] => [
  ...new Set(activeHostHttpAddresses(service).map((address) => address.url)),
];
