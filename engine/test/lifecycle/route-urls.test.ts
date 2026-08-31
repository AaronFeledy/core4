import { expect, test } from "bun:test";

import { type ProxyAuthority, type RoutePlan, ServiceName } from "@lando/sdk/schema";

import { proxyUrlsByService } from "../../src/lifecycle/route-urls.ts";

const webRoute = (hostname: string, scheme: RoutePlan["scheme"]): RoutePlan => {
  const service = ServiceName.make("web");
  return { hostname, scheme, service, backend: { service, protocol: "http", port: 8080 } };
};

test("brackets IPv6 authorities in route URLs", () => {
  const service = ServiceName.make("web");
  const routes: ReadonlyArray<RoutePlan> = [
    {
      hostname: "2001:db8::1",
      scheme: "https",
      service,
      backend: { service, protocol: "http", port: 8080 },
    },
  ];
  const authorities: ReadonlyArray<ProxyAuthority> = [
    { scheme: "https", hostname: "2001:db8::1", port: 4443 },
  ];

  expect(proxyUrlsByService(routes, authorities).get(service)).toEqual(["https://[2001:db8::1]:4443"]);
});

test("omits :80 on http and :443 on https authorities", () => {
  // Given: default-port authorities for both schemes.
  const httpRoute = webRoute("app.lndo.site", "http");
  const httpsRoute = webRoute("app.lndo.site", "https");
  const httpAuthority: ProxyAuthority = { scheme: "http", hostname: "app.lndo.site", port: 80 };
  const httpsAuthority: ProxyAuthority = { scheme: "https", hostname: "app.lndo.site", port: 443 };

  // When: URLs are rendered from those authorities.
  const httpUrls = proxyUrlsByService([httpRoute], [httpAuthority]).get(httpRoute.service);
  const httpsUrls = proxyUrlsByService([httpsRoute], [httpsAuthority]).get(httpsRoute.service);

  // Then: the default port is omitted.
  expect(httpUrls).toEqual(["http://app.lndo.site"]);
  expect(httpsUrls).toEqual(["https://app.lndo.site"]);
});

test("keeps explicit non-default ports for occupied-hop and degraded authorities", () => {
  // Given: high-port authorities used when 80/443 are unavailable.
  const httpRoute = webRoute("app.lndo.site", "http");
  const httpsRoute = webRoute("app.lndo.site", "https");
  const httpAuthority: ProxyAuthority = { scheme: "http", hostname: "app.lndo.site", port: 38080 };
  const httpsAuthority: ProxyAuthority = { scheme: "https", hostname: "app.lndo.site", port: 38443 };

  // When: URLs are rendered from those authorities.
  const httpUrls = proxyUrlsByService([httpRoute], [httpAuthority]).get(httpRoute.service);
  const httpsUrls = proxyUrlsByService([httpsRoute], [httpsAuthority]).get(httpsRoute.service);

  // Then: the explicit port is preserved.
  expect(httpUrls).toEqual(["http://app.lndo.site:38080"]);
  expect(httpsUrls).toEqual(["https://app.lndo.site:38443"]);
});

test("keeps explicit first-fallback ports 8080 and 8443", () => {
  // Given: familiar first-fallback authorities when 80/443 are unavailable.
  const httpRoute = webRoute("app.lndo.site", "http");
  const httpsRoute = webRoute("app.lndo.site", "https");
  const httpAuthority: ProxyAuthority = { scheme: "http", hostname: "app.lndo.site", port: 8080 };
  const httpsAuthority: ProxyAuthority = { scheme: "https", hostname: "app.lndo.site", port: 8443 };

  // When: URLs are rendered from those authorities.
  const httpUrls = proxyUrlsByService([httpRoute], [httpAuthority]).get(httpRoute.service);
  const httpsUrls = proxyUrlsByService([httpsRoute], [httpsAuthority]).get(httpsRoute.service);

  // Then: the explicit port is preserved.
  expect(httpUrls).toEqual(["http://app.lndo.site:8080"]);
  expect(httpsUrls).toEqual(["https://app.lndo.site:8443"]);
});
