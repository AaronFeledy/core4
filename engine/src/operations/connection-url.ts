import {
  type EndpointRef,
  type PublicRouteFact,
  type RoutePlan,
  type ServiceConnection,
  type ServicePlan,
  type ServiceRoute,
  isWildcardHostname,
  routeListenerPreference,
  selectHttpEndpoint,
} from "@lando/sdk/schema";

type ServedRoute = Extract<ServiceRoute, { readonly binding: "assigned" }>;
type AddressKey = "host" | "protocol" | "port" | "pathPrefix" | "hostMatch";
export type ExactRouteAddress = Pick<
  Extract<ServedRoute, { readonly hostMatch: "exact" }>,
  AddressKey | "url"
>;
export type PatternRouteAddress = Pick<Extract<ServedRoute, { readonly hostMatch: "pattern" }>, AddressKey>;
export type RouteAddress = ExactRouteAddress | PatternRouteAddress;

/** A route's public identity, whether or not the router has assigned a port. */
export const routeHost = (
  route: RoutePlan,
  protocol: RouteAddress["protocol"],
): Omit<RouteAddress, "port"> => ({
  host: route.hostname.toLowerCase(),
  protocol,
  pathPrefix: route.pathPrefix ?? "",
  hostMatch: isWildcardHostname(route.hostname) ? "pattern" : "exact",
});

export const routeAddress = (
  route: RoutePlan,
  protocol: RouteAddress["protocol"],
  port: number,
): RouteAddress => {
  const { hostMatch, ...location } = routeHost(route, protocol);
  return hostMatch === "exact"
    ? { ...location, hostMatch, port, url: connectionUrl({ ...location, port }) }
    : { ...location, hostMatch, port };
};

/**
 * The route a public service URL names: the first concrete HTTPS or `both` route, otherwise the
 * first concrete HTTP route, in route-table order. Wildcard hostnames never name a URL.
 */
export const primaryConcreteRoute = (
  routes: readonly RoutePlan[],
  service: string,
): RoutePlan | undefined => {
  const own = routes.filter((route) => route.service === service && !isWildcardHostname(route.hostname));
  return own.find((route) => route.scheme !== "http") ?? own[0];
};

/** The scheme a route's public URL uses: a `both` route is named by its HTTPS address. */
export const routeUrlScheme = (route: RoutePlan): "http" | "https" =>
  route.scheme === "http" ? "http" : "https";

export const primaryRouteCandidates = (
  routes: readonly RoutePlan[],
  service: Pick<ServicePlan, "name" | "endpoints" | "certs">,
): readonly RoutePlan[] => {
  const own = routes.filter((route) => route.service === service.name);
  const https = own.filter((route) => route.scheme !== "http");
  const endpoint = selectHttpEndpoint(
    service.endpoints,
    undefined,
    routeListenerPreference("https", service.certs !== undefined),
  );
  const listeners =
    endpoint.status === "selected"
      ? own.filter(
          (route) =>
            route.backend.port === endpoint.endpoint.port &&
            route.backend.protocol === endpoint.endpoint.protocol,
        )
      : [];
  return listeners.length > 0 ? listeners : https.length > 0 ? https : own;
};

export interface RouteFacts extends Readonly<Record<PublicRouteFact, string>> {}

/**
 * Project a route's public facts by hand rather than through `new URL()`, which rewrites or rejects
 * hostnames routes admit, such as `127.1` and `web.123`. The port is omitted only for http on 80
 * and https on 443.
 */
export const routeFacts = ({ url, host, protocol, port }: ExactRouteAddress): RouteFacts => ({
  url,
  hostname: host,
  origin: connectionUrl({ host, protocol, port }),
  publicPort: String(port),
  scheme: protocol,
});

export const connectionHost = (address: string): string => {
  const host = address.replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host === "::" ? "::1" : host;
};

type ConnectionAuthorityInput = {
  readonly host: string;
  readonly port: number;
  readonly protocol: string;
  readonly pathPrefix?: string;
};

/** The host, nonstandard port, and path prefix of a client address. */
export const connectionAuthority = (input: ConnectionAuthorityInput): string => {
  const normalized = input.host.replace(/^\[|\]$/gu, "").toLowerCase();
  const host = normalized.includes(":") ? `[${normalized}]` : normalized;
  const standard =
    (input.protocol === "http" && input.port === 80) || (input.protocol === "https" && input.port === 443);
  return `${host}${standard ? "" : `:${input.port}`}${input.pathPrefix ?? ""}`;
};

export const connectionUrl = (input: ConnectionAuthorityInput): string =>
  `${input.protocol}://${connectionAuthority(input)}`;

export const effectiveRoutePath = (prefix: string): string => (prefix === "" ? "/" : prefix);

export const clientConnectionUrls = (input: {
  readonly service: ServicePlan;
  readonly endpoint: EndpointRef;
  readonly protocol: ServiceConnection["protocol"];
  readonly host: string;
  readonly port: number;
}): { readonly url: string; readonly alternateUrls: readonly string[] } => {
  const uri = (protocol: string) => connectionUrl({ ...input, protocol });
  const connection = input.service.connection;
  if (
    input.protocol === "tcp" &&
    input.endpoint.transport === "tcp" &&
    connection?.family === "postgres" &&
    connection.port === input.endpoint.port
  ) {
    const user = encodeURIComponent(connection.creds.user);
    const database = encodeURIComponent(connection.creds.database);
    return { url: `${uri("postgresql").replace("://", `://${user}@`)}/${database}`, alternateUrls: [] };
  }
  const tcpPorts = input.service.endpoints.flatMap((endpoint) =>
    endpoint.protocol === "tcp" ? [endpoint.port] : [],
  );
  const markedPrimary = input.service.endpoints.some(
    (endpoint) => endpoint.protocol !== "unix" && endpoint.primary,
  );
  const family =
    input.protocol === "tcp" &&
    tcpPorts.includes(input.endpoint.port) &&
    (input.endpoint.primary || (!markedPrimary && new Set(tcpPorts).size === 1));
  if (family) {
    switch (input.service.type.split(":")[0]) {
      case "memcached":
        return { url: uri("memcached"), alternateUrls: [] };
      case "valkey":
        return { url: uri("valkey"), alternateUrls: [uri("redis")] };
    }
  }
  return { url: uri(input.protocol), alternateUrls: [] };
};
