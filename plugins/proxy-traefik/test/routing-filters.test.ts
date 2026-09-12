import { describe, expect, test } from "bun:test";

import { AppId, type RoutePlan, ServiceName } from "@lando/sdk/schema";

import { renderTraefikDynamicConfig } from "../src/routing.ts";

const app = AppId.make("demo");
const base: RoutePlan = {
  hostname: "api.demo.lndo.site",
  scheme: "http",
  service: ServiceName.make("api"),
  backend: { service: ServiceName.make("api"), protocol: "http", port: 8080 },
};
const router = {
  rule: "Host(`api.demo.lndo.site`)",
  entryPoints: ["web"],
  service: "route-demo-0",
} as const;
const services = {
  "route-demo-0": { loadBalancer: { servers: [{ url: "http://api.demo.internal:8080" }] } },
} as const;
const filters = [
  { type: "stripPrefix", prefix: "/old" },
  { type: "addPrefix", prefix: "/new" },
  { type: "requestHeader", name: "merge-request", header: "X-Request", value: 'yes: "quoted"\nnext' },
  { type: "responseHeader", name: "merge-response", header: "X-Response", value: "false" },
  { type: "redirect", to: "https://example.com/new?q=one#two", permanent: true },
] as const;
const names = [
  "route-demo-0-f0-stripPrefix",
  "route-demo-0-f1-addPrefix",
  "route-demo-0-f2-requestHeader",
  "route-demo-0-f3-responseHeader",
  "route-demo-0-f4-redirect",
] as const;
const middlewares = {
  "route-demo-0-f0-stripPrefix": { stripPrefix: { prefixes: ["/old"] } },
  "route-demo-0-f1-addPrefix": { addPrefix: { prefix: "/new" } },
  "route-demo-0-f2-requestHeader": {
    headers: { customRequestHeaders: { "X-Request": 'yes: "quoted"\nnext' } },
  },
  "route-demo-0-f3-responseHeader": { headers: { customResponseHeaders: { "X-Response": "false" } } },
  "route-demo-0-f4-redirect": {
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
      http: { routers: { "route-demo-0-http": { ...router, middlewares: names } }, services, middlewares },
    });
    expect(parsed).toHaveProperty("http.routers.route-demo-0-http.middlewares", names);
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
          "route-demo-0-http": { ...router, middlewares: names },
          "route-demo-0-https": { ...router, entryPoints: ["websecure"], tls: {}, middlewares: names },
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
      const ns = appName === "demo" ? "demo" : "team%40app%2Fother";
      const routes: readonly RoutePlan[] = [base, { ...base, filters: [filters[1], filters[1]] }];
      // When
      const parsed = Bun.YAML.parse(renderTraefikDynamicConfig(routes, AppId.make(appName)));
      // Then
      expect(parsed).toEqual({
        http: {
          routers: {
            [`route-${ns}-0-http`]: { ...router, service: `route-${ns}-0` },
            [`route-${ns}-1-http`]: {
              ...router,
              service: `route-${ns}-1`,
              middlewares: [`route-${ns}-1-f0-addPrefix`, `route-${ns}-1-f1-addPrefix`],
            },
          },
          services: Object.fromEntries(
            [0, 1].map((index) => [
              `route-${ns}-${index}`,
              { loadBalancer: { servers: [{ url: `http://api.${appName}.internal:8080` }] } },
            ]),
          ),
          middlewares: {
            [`route-${ns}-1-f0-addPrefix`]: { addPrefix: { prefix: "/new" } },
            [`route-${ns}-1-f1-addPrefix`]: { addPrefix: { prefix: "/new" } },
          },
        },
      });
    },
  );

  test.each([
    [
      "compiles wildcard hostnames to anchored HostRegexp",
      "*.API.*.SITE",
      "HostRegexp(`^[a-z0-9-]+\\.api\\.[a-z0-9-]+\\.site$`)",
    ],
    [
      "escapes regex metacharacters in wildcard hostnames",
      "*.+?()[]{}^$|\\.SITE",
      "HostRegexp(`^[a-z0-9-]+\\.\\+\\?\\(\\)\\[\\]\\{\\}\\^\\$\\|\\\\\\.site$`)",
    ],
    ["keeps Host() for non-wildcard hostnames", "API.demo.lndo.site", "Host(`API.demo.lndo.site`)"],
  ])("%s", (_name, hostname, rule) => {
    // Given
    const route = { ...base, hostname, pathPrefix: "/v1" };
    // When
    const parsed = Bun.YAML.parse(renderTraefikDynamicConfig([route], app));
    // Then
    expect(parsed).toEqual({
      http: {
        routers: { "route-demo-0-http": { ...router, rule: `${rule} && PathPrefix(\`/v1\`)` } },
        services,
      },
    });
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
        routers: { "route-demo-0-http": { ...router, middlewares: ["route-demo-0-f0-redirect"] } },
        services,
        middlewares: {
          "route-demo-0-f0-redirect": {
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
      expect(Bun.YAML.parse(yaml)).toEqual({ http: { routers: { "route-demo-0-http": router }, services } });
      expect(yaml).toBe(
        [
          "http:",
          "  routers:",
          "    route-demo-0-http:",
          '      rule: "Host(`api.demo.lndo.site`)"',
          "      entryPoints: [web]",
          "      service: route-demo-0",
          "  services:",
          "    route-demo-0:",
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
        routers: { "route-demo-0-http": { ...router, rule: `${router.rule} && PathPrefix(\`/v1\`)` } },
        services,
      },
    });
  });
});
