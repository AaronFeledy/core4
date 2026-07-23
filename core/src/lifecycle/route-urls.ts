import type { ProxyApplyResult, ProxyAuthority, RoutePlan, ServiceName } from "@lando/sdk/schema";

const authorityUrl = (authority: ProxyAuthority, pathPrefix?: string): string =>
  `${authority.scheme}://${authority.hostname}:${authority.port}${pathPrefix ?? ""}`;

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
