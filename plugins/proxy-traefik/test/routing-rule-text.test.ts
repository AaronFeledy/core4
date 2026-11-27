import { expect, test } from "bun:test";

import { type RoutePlan, ServiceName } from "@lando/sdk/schema";

import {
  DEFAULT_AUTHORITY_PORTS,
  persistedAuthorities,
  renderTraefikDynamicConfig,
  routeRule,
} from "../src/routing.ts";
import { routeOwner } from "./route-owner-fixture.ts";

const owner = routeOwner("rule-text-test");
const web = ServiceName.make("web");
const route = (hostname: string, pathPrefix?: string): RoutePlan => ({
  hostname,
  priority: 2,
  scheme: "http",
  service: web,
  backend: { service: web, protocol: "http", port: 8080 },
  ...(pathPrefix === undefined ? {} : { pathPrefix }),
});

const wildcardRules = [
  ["*.app.lndo.site", String.raw`HostRegexp("^[a-z0-9-]+\\.app\\.lndo\\.site$")`, undefined],
  ["*-app.lndo.site", String.raw`HostRegexp("^[a-z0-9-]+-app\\.lndo\\.site$")`, undefined],
  ["api*.app.lndo.site", String.raw`HostRegexp("^api[a-z0-9-]+\\.app\\.lndo\\.site$")`, undefined],
  ["wild.*.app.lndo.site", String.raw`HostRegexp("^wild\\.[a-z0-9-]+\\.app\\.lndo\\.site$")`, undefined],
  ["*.*.lndo.site", String.raw`HostRegexp("^[a-z0-9-]+\\.[a-z0-9-]+\\.lndo\\.site$")`, undefined],
  ["a*b*c.lndo.site", String.raw`HostRegexp("^a[a-z0-9-]+b[a-z0-9-]+c\\.lndo\\.site$")`, undefined],
  ["*.API.*.SITE", String.raw`HostRegexp("^[a-z0-9-]+\\.api\\.[a-z0-9-]+\\.site$")`, undefined],
  [
    "lets.combine.*.lndo.site",
    String.raw`HostRegexp("^lets\\.combine\\.[a-z0-9-]+\\.lndo\\.site$") && PathPrefix("/everything/for-real")`,
    "/everything/for-real",
  ],
] as const;

test.each([
  ["app.lndo.site", 'Host("app.lndo.site")', undefined],
  ["API.Demo.lndo.site", 'Host("API.Demo.lndo.site")', undefined],
  ["127.0.0.1", 'Host("127.0.0.1")', undefined],
  ["xn--bcher-kva.lndo.site", 'Host("xn--bcher-kva.lndo.site")', undefined],
  ...wildcardRules,
] as const)("renders the Traefik rule for %s verbatim", (hostname, expected, pathPrefix) => {
  expect(routeRule(route(hostname, pathPrefix))).toBe(expected);
});

test.each(wildcardRules)(
  "recovers the wildcard authority for %s from persisted YAML",
  (hostname, _, pathPrefix) => {
    const yaml = renderTraefikDynamicConfig([route(hostname, pathPrefix)], owner);

    expect(persistedAuthorities(yaml, DEFAULT_AUTHORITY_PORTS)).toEqual([
      { scheme: "http", hostname: hostname.toLowerCase(), port: DEFAULT_AUTHORITY_PORTS.http },
    ]);
  },
);
