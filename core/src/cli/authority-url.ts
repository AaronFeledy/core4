import type { EndpointPlan, RoutePlan } from "@lando/sdk/schema";

export type HttpScheme = "http" | "https";
type AuthorityProtocol = HttpScheme | "memcached" | "postgresql" | "redis" | "tcp" | "udp" | "valkey";

const AUTHORITY_BASE_URL = {
  http: "http://localhost",
  https: "https://localhost",
  memcached: "memcached://localhost",
  postgresql: "postgresql://localhost",
  redis: "redis://localhost",
  tcp: "tcp://localhost",
  udp: "udp://localhost",
  valkey: "valkey://localhost",
} as const satisfies Readonly<Record<AuthorityProtocol, string>>;

const ROUTE_SCHEMES = {
  http: ["http"],
  https: ["https"],
  both: ["http", "https"],
} as const satisfies Readonly<Record<RoutePlan["scheme"], ReadonlyArray<HttpScheme>>>;

export const routeSchemes = (route: RoutePlan, all: boolean): ReadonlyArray<HttpScheme> =>
  all ? ROUTE_SCHEMES[route.scheme] : [route.scheme === "http" ? "http" : "https"];

const setHostname = (url: URL, hostname: string): void => {
  url.hostname = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
};

export const routeUrl = (route: RoutePlan, scheme: HttpScheme): URL => {
  const url = new URL(AUTHORITY_BASE_URL[scheme]);
  setHostname(url, route.hostname);
  const port = route.authorityPorts?.[scheme];
  if (port !== undefined) url.port = String(port);
  if (route.pathPrefix !== undefined) url.pathname = route.pathPrefix;
  return url;
};

export const endpointHostname = (endpoint: EndpointPlan): string => endpoint.bind ?? "localhost";

export const endpointUrl = (endpoint: EndpointPlan, protocol: AuthorityProtocol): URL => {
  const url = new URL(AUTHORITY_BASE_URL[protocol]);
  setHostname(url, endpointHostname(endpoint));
  const port = endpoint.publishedPort ?? endpoint.port;
  if (port !== undefined) url.port = String(port);
  return url;
};

export const formatAuthorityUrl = (url: URL): string =>
  url.origin !== "null" && url.pathname === "/" && url.search === "" && url.hash === ""
    ? url.origin
    : url.href;
