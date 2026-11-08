import { describe, expect, test } from "bun:test";

import { type RoutePlan, ServiceName } from "@lando/sdk/schema";

import { DEFAULT_AUTHORITY_PORTS, persistedAuthorities, renderTraefikDynamicConfig } from "../src/routing.ts";
import { routeMetadataLine, routeObjectName, routeOwner } from "./route-owner-fixture.ts";

const app = routeOwner("demo");
const base: RoutePlan = {
  hostname: "api.demo.lndo.site",
  priority: 2,
  scheme: "http",
  service: ServiceName.make("api"),
  backend: { service: ServiceName.make("api"), protocol: "http", port: 8080 },
};
const svc0 = routeObjectName(app, 0);
const routerHttp = `${svc0}-http`;
const routerHttps = `${svc0}-https`;
const router = {
  priority: 2,
  rule: 'Host("api.demo.lndo.site")',
  entryPoints: ["web"],
  service: svc0,
} as const;
const services = {
  [svc0]: { loadBalancer: { servers: [{ url: "http://api.demo.internal:8080" }] } },
} as const;
const filters = [
  { type: "stripPrefix", prefix: "/old" },
  { type: "addPrefix", prefix: "/new" },
  { type: "requestHeader", name: "merge-request", header: "X-Request", value: 'yes: "quoted"\nnext' },
  { type: "responseHeader", name: "merge-response", header: "X-Response", value: "false" },
  { type: "redirect", to: "https://example.com/new?q=one#two", permanent: true },
] as const;
const names = [
  `${svc0}-f0-stripPrefix`,
  `${svc0}-f1-addPrefix`,
  `${svc0}-f2-requestHeader`,
  `${svc0}-f3-responseHeader`,
  `${svc0}-f4-redirect`,
] as const;
const middlewares = {
  [`${svc0}-f0-stripPrefix`]: { stripPrefix: { prefixes: ["/old"] } },
  [`${svc0}-f1-addPrefix`]: { addPrefix: { prefix: "/new" } },
  [`${svc0}-f2-requestHeader`]: {
    headers: { customRequestHeaders: { "X-Request": 'yes: "quoted"\nnext' } },
  },
  [`${svc0}-f3-responseHeader`]: { headers: { customResponseHeaders: { "X-Response": "false" } } },
  [`${svc0}-f4-redirect`]: {
    redirectRegex: { regex: "^.*$", replacement: "https://example.com/new?q=one#two", permanent: true },
  },
} as const;

describe("Traefik route filter YAML", () => {
  test("renders all five filters as middlewares in authored order", () => {
    // Given
    const route = { ...base, filters };
    // When
    const parsed = Bun.YAML.parse(renderTraefikDynamicConfig([route], app));
    // Then
    expect(parsed).toEqual({
      http: { routers: { [routerHttp]: { ...router, middlewares: names } }, services, middlewares },
    });
    expect(parsed).toHaveProperty(`http.routers.${routerHttp}.middlewares`, names);
  });

  test("attaches the same middleware list to the http and https routers of a both-scheme route", () => {
    // Given
    const route: RoutePlan = { ...base, scheme: "both", filters };
    // When
    const parsed = Bun.YAML.parse(renderTraefikDynamicConfig([route], app));
    // Then
    expect(parsed).toEqual({
      http: {
        routers: {
          [routerHttp]: { ...router, middlewares: names },
          [routerHttps]: { ...router, entryPoints: ["websecure"], tls: {}, middlewares: names },
        },
        services,
        middlewares,
      },
    });
  });

  test.each(["demo", "team@app/other"])(
    "namespaces middleware names per app, route index, and filter index (%s)",
    (appName) => {
      // Given
      const owner = routeOwner(appName);
      const n0 = routeObjectName(owner, 0);
      const n1 = routeObjectName(owner, 1);
      const routes: readonly RoutePlan[] = [base, { ...base, filters: [filters[1], filters[1]] }];
      // When
      const parsed = Bun.YAML.parse(renderTraefikDynamicConfig(routes, owner));
      // Then
      expect(parsed).toEqual({
        http: {
          routers: {
            [`${n0}-http`]: { ...router, service: n0 },
            [`${n1}-http`]: {
              ...router,
              service: n1,
              middlewares: [`${n1}-f0-addPrefix`, `${n1}-f1-addPrefix`],
            },
          },
          services: Object.fromEntries(
            [0, 1].map((index) => [
              routeObjectName(owner, index),
              { loadBalancer: { servers: [{ url: `http://api.${appName}.internal:8080` }] } },
            ]),
          ),
          middlewares: {
            [`${n1}-f0-addPrefix`]: { addPrefix: { prefix: "/new" } },
            [`${n1}-f1-addPrefix`]: { addPrefix: { prefix: "/new" } },
          },
        },
      });
    },
  );

  test.each([
    [
      "compiles wildcard hostnames to anchored HostRegexp",
      "*.API.*.SITE",
      'HostRegexp("^[a-z0-9-]+\\\\.api\\\\.[a-z0-9-]+\\\\.site$")',
    ],
    [
      "escapes regex metacharacters in wildcard hostnames",
      "*.+?()[]{}^$|\\.SITE",
      'HostRegexp("^[a-z0-9-]+\\\\.\\\\+\\\\?\\\\(\\\\)\\\\[\\\\]\\\\{\\\\}\\\\^\\\\$\\\\|\\\\\\\\\\\\.site$")',
    ],
    ["keeps Host() for non-wildcard hostnames", "API.demo.lndo.site", 'Host("API.demo.lndo.site")'],
  ])("%s", (_name, hostname, rule) => {
    // Given
    const route = { ...base, hostname, pathPrefix: "/v1" };
    // When
    const parsed = Bun.YAML.parse(renderTraefikDynamicConfig([route], app));
    // Then
    expect(parsed).toEqual({
      http: {
        routers: { [routerHttp]: { ...router, rule: `${rule} && PathPrefix("/v1")` } },
        services,
      },
    });
  });

  test("recovers Host and HostRegexp authorities from persisted Traefik YAML", () => {
    // Given
    const literal = { ...base, hostname: "API.demo.lndo.site", pathPrefix: "/v1" };
    const wildcard = { ...base, hostname: "*.API.*.SITE", scheme: "https" as const };
    // When
    const yaml = renderTraefikDynamicConfig([literal, wildcard], app);
    // Then
    expect(persistedAuthorities(yaml, DEFAULT_AUTHORITY_PORTS)).toEqual([
      { scheme: "http", hostname: "API.demo.lndo.site", port: DEFAULT_AUTHORITY_PORTS.http },
      { scheme: "https", hostname: "*.api.*.site", port: DEFAULT_AUTHORITY_PORTS.https },
    ]);
  });

  test.each([undefined, false, true])("preserves authored redirect permanence (%s)", (permanent) => {
    // Given
    const route: RoutePlan = {
      ...base,
      filters: [
        {
          type: "redirect",
          to: '/new: "quoted"\n#fragment',
          ...(permanent === undefined ? {} : { permanent }),
        },
      ],
    };
    // When
    const parsed = Bun.YAML.parse(renderTraefikDynamicConfig([route], app));
    // Then
    expect(parsed).toEqual({
      http: {
        routers: { [routerHttp]: { ...router, middlewares: [`${svc0}-f0-redirect`] } },
        services,
        middlewares: {
          [`${svc0}-f0-redirect`]: {
            redirectRegex: {
              regex: "^.*$",
              replacement: '/new: "quoted"\n#fragment',
              ...(permanent === undefined ? {} : { permanent }),
            },
          },
        },
      },
    });
  });

  test.each([{}, { filters: [] }])(
    "emits no middlewares block when no route has filters (%s)",
    (filterFields) => {
      // Given
      const route = { ...base, ...filterFields };
      // When
      const yaml = renderTraefikDynamicConfig([route], app);
      // Then
      expect(Bun.YAML.parse(yaml)).toEqual({ http: { routers: { [routerHttp]: router }, services } });
      expect(yaml).toBe(
        [
          routeMetadataLine(app),
          "http:",
          "  routers:",
          `    ${routerHttp}:`,
          '      rule: "Host(\\"api.demo.lndo.site\\")"',
          "      entryPoints: [web]",
          "      priority: 2",
          `      service: ${svc0}`,
          "  services:",
          `    ${svc0}:`,
          "      loadBalancer:",
          "        servers:",
          "          - url: http://api.demo.internal:8080",
          "",
        ].join("\n"),
      );
    },
  );

  test("does not strip pathPrefix without a stripPrefix filter", () => {
    // Given
    const route = { ...base, pathPrefix: "/v1" };
    // When
    const parsed = Bun.YAML.parse(renderTraefikDynamicConfig([route], app));
    // Then
    expect(parsed).toEqual({
      http: {
        routers: { [routerHttp]: { ...router, rule: `${router.rule} && PathPrefix("/v1")` } },
        services,
      },
    });
  });
});
