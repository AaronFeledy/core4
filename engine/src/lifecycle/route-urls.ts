import type { ProxyApplyResult, ProxyAuthority, RoutePlan, ServiceName } from "@lando/sdk/schema";

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
};

const defaultPortForScheme = (scheme: ProxyAuthority["scheme"]): number => {
  switch (scheme) {
    case "http":
      return 80;
    case "https":
      return 443;
    default:
      return assertNever(scheme);
  }
};

const authorityUrl = (authority: ProxyAuthority, pathPrefix?: string): string => {
  const hostname = authority.hostname.includes(":") ? `[${authority.hostname}]` : authority.hostname;
  const portSuffix = authority.port === defaultPortForScheme(authority.scheme) ? "" : `:${authority.port}`;
  return `${authority.scheme}://${hostname}${portSuffix}${pathPrefix ?? ""}`;
};

const routeAcceptsAuthority = (route: RoutePlan, authority: ProxyAuthority): boolean =>
  route.hostname === authority.hostname && (route.scheme === "both" || route.scheme === authority.scheme);

export const proxyUrlsByService = (
  routes: ReadonlyArray<RoutePlan>,
  authorities: ReadonlyArray<ProxyAuthority>,
): ReadonlyMap<ServiceName, ReadonlyArray<string>> => {
  const urls = new Map<ServiceName, Array<string>>();
  for (const route of routes) {
    const serviceUrls = urls.get(route.service) ?? [];
    serviceUrls.push(
      ...authorities
        .filter((authority) => routeAcceptsAuthority(route, authority))
        .map((authority) => authorityUrl(authority, route.pathPrefix)),
    );
    urls.set(route.service, serviceUrls);
  }
  return urls;
};

export const appliedProxyUrlsByService = (
  result: ProxyApplyResult,
): ReadonlyMap<ServiceName, ReadonlyArray<string>> =>
  proxyUrlsByService(result.appliedRoutes, result.authorities);
