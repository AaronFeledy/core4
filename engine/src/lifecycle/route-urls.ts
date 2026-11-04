import type { ProxyAuthority, RoutePlan, ServiceName } from "@lando/sdk/schema";
import { connectionUrl } from "../operations/connection-url.ts";

const authorityUrl = (authority: ProxyAuthority, pathPrefix?: string): string => {
  return connectionUrl({
    host: authority.hostname,
    port: authority.port,
    protocol: authority.scheme,
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
  });
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
    urls.set(route.service, [...new Set(serviceUrls)]);
  }
  return urls;
};
