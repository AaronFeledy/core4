import { expect, test } from "bun:test";
import { type AppPlan, type PublicationObservation, ServiceInfo, type ServicePlan } from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { infoForPlan } from "../../src/operations/info.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const route = {
  hostname: "web.demo.lndo.site",
  priority: 2,
  scheme: "https",
  service: web.name,
  pathPrefix: "/api",
  backend: { service: web.name, protocol: "http", port: 3000 },
} satisfies AppPlan["routes"][number];

const infoOf = (
  service: ServicePlan,
  options: {
    readonly run?: "exited" | "unknown" | "paused" | "restarting" | "running";
    readonly publications?: PublicationObservation;
    readonly routerEnabled?: boolean;
    readonly observedRoute?: boolean;
    readonly publishedRoutes?: readonly AppPlan["routes"][number][];
    readonly routes?: readonly AppPlan["routes"][number][];
  } = {},
) => {
  const planned = {
    ...plan,
    services: { [service.name]: service },
    routes: [...(options.routes ?? [route])],
    router: { enabled: options.routerEnabled ?? true },
  };
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed({
        app: planned.id,
        service: service.name,
        providerId: planned.provider,
        status: options.run ?? "running",
        publications: options.publications ?? { status: "unknown" as const },
      }),
  };
  const publications = planned.routes.map((route) => ({
    route,
    authority: { scheme: "https" as const, hostname: route.hostname, port: 38443 },
  }));
  return Effect.runPromise(
    infoForPlan(planned).pipe(
      Effect.provideService(
        RuntimeProviderRegistry,
        makeTestRuntimeProviderRegistry({
          list: Effect.succeed([planned.provider]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Effect.provide(
        Layer.succeed(RouterService, {
          ...makeTestRouterService(),
          observeRoutes: () =>
            Effect.succeed({
              configuredAuthorities: publications.map(({ authority }) => authority),
              observation:
                options.observedRoute === true
                  ? {
                      status: "present" as const,
                      publications:
                        options.publishedRoutes?.map((route) => ({
                          route,
                          authority: { scheme: "https" as const, hostname: route.hostname, port: 38443 },
                        })) ?? publications,
                    }
                  : { status: "unknown" as const },
            }),
        }),
      ),
    ),
  );
};

const filteredRoute: typeof route & Pick<AppPlan["routes"][number], "filters"> = {
  ...route,
  filters: [
    { kind: "stripPrefix", prefix: "/api" },
    { kind: "addPrefix", prefix: "/v1" },
  ],
};

test.each([
  { ...filteredRoute, priority: 3 },
  {
    ...filteredRoute,
    filters: [
      { kind: "stripPrefix", prefix: "/api" },
      { kind: "addPrefix", prefix: "/v2" },
    ],
  },
  { ...filteredRoute, filters: filteredRoute.filters?.toReversed() ?? [] },
] satisfies AppPlan["routes"])("does not report stale publication as active: %j", async (stale) => {
  const result = await infoOf(web, {
    routes: [filteredRoute],
    observedRoute: true,
    publishedRoutes: [stale],
  });
  expect(result.services[0]?.routes).toMatchObject([
    { binding: "assigned", url: "https://web.demo.lndo.site:38443/api", state: "inactive" },
  ]);
});

test("recognizes equivalent published filters regardless of authoring names and header case", async () => {
  const planned: AppPlan["routes"][number] = {
    ...route,
    filters: [
      { kind: "requestHeader", name: "merge-key", header: "X-Custom", value: "yes" },
      { kind: "redirect", to: "/home" },
    ],
  };
  const result = await infoOf(web, {
    routes: [planned],
    observedRoute: true,
    publishedRoutes: [
      {
        ...planned,
        filters: [
          { kind: "requestHeader", header: "x-custom", value: "yes" },
          { kind: "redirect", to: "/home", permanent: false },
        ],
      },
    ],
  });
  expect(result.services[0]?.routes).toMatchObject([
    { binding: "assigned", url: "https://web.demo.lndo.site:38443/api", state: "active" },
  ]);
});

test("round trips actual info without redundant fields or runtime leakage", async () => {
  const result = await infoOf(web, {
    publications: {
      status: "present",
      bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 3000 }],
    },
  });
  const encoded = result.services.map((row) => Schema.encodeSync(ServiceInfo)(row));
  const decoded = encoded.map((row) => Schema.decodeUnknownSync(ServiceInfo)(row));
  expect(result.services).toEqual(decoded);
  expect(Object.keys(result.services[0] ?? {}).sort()).toEqual([
    "api",
    "app",
    "artifact",
    "connections",
    "health",
    "hostnames",
    "primary",
    "provider",
    "readiness",
    "routes",
    "service",
    "status",
    "type",
    "url",
  ]);
});

test.each(["unknown", "present", "missing"] as const)(
  "keeps planned internals and fixed host addresses with %s evidence",
  async (status) => {
    const result = await infoOf(web, {
      publications: status === "present" ? { status, bindings: [] } : { status },
    });
    const rows = result.services[0]?.connections ?? [];
    expect(rows.filter((row) => row.scope === "app").map((row) => row.url)).toEqual(["http://web:3000"]);
    expect(rows.find((row) => row.source === "publication")).toMatchObject({
      url: "http://localhost:3000",
      state: status === "unknown" ? "unknown" : "inactive",
    });
  },
);

test.each([
  ["exited", "stopped"],
  ["unknown", "unknown"],
  ["paused", "paused"],
  ["restarting", "restarting"],
] as const)("projects the %s run state as %s and keeps the configured route prefix", async (run, state) => {
  const result = await infoOf(web, { run, observedRoute: true });
  expect(result.services[0]?.status).toBe(state);
  expect(result.services[0]?.routes[0]).toMatchObject({
    hostMatch: "exact",
    url: "https://web.demo.lndo.site:38443/api",
    state: state === "unknown" || state === "restarting" ? "unknown" : "inactive",
  });
});

test("retains disabled routes but never describes them as active", async () => {
  const result = await infoOf(web, { routerEnabled: false, observedRoute: true });
  expect(result.services[0]?.routes[0]).toMatchObject({
    hostMatch: "exact",
    state: "inactive",
    url: "https://web.demo.lndo.site:38443/api",
  });
});

test("keeps each same-host route path once when an authority repeats", async () => {
  const { pathPrefix: _pathPrefix, ...root } = route;
  const result = await infoOf(web, { routes: [root, route], observedRoute: true });
  const urls = result.services[0]?.routes.map(
    (row) => row.binding === "assigned" && row.hostMatch === "exact" && row.url,
  );
  expect(urls).toEqual(["https://web.demo.lndo.site:38443", "https://web.demo.lndo.site:38443/api"]);
});

test("keeps a loopback route hostname while normalizing a loopback publication bind", async () => {
  const result = await infoOf(web, {
    routes: [{ ...route, hostname: "127.0.0.1" }],
    observedRoute: true,
    publications: {
      status: "present",
      bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 3000 }],
    },
  });
  const service = result.services[0];
  expect(service?.url).toBe("https://127.0.0.1:38443/api");
  expect(service?.routes[0]).toMatchObject({
    host: "127.0.0.1",
    hostMatch: "exact",
    url: "https://127.0.0.1:38443/api",
  });
  expect(service?.connections.find((row) => row.source === "publication")).toMatchObject({
    host: "localhost",
    url: "http://localhost:3000",
  });
});

test.each([
  ["postgres", "postgresql://db%40user@[::1]:49152/app%2Fdb", []],
  ["postgres:18", "postgresql://db%40user@[::1]:49152/app%2Fdb", []],
  ["memcached", "memcached://[::1]:49152", []],
  ["memcached:1.6", "memcached://[::1]:49152", []],
  ["valkey", "valkey://[::1]:49152", ["redis://[::1]:49152"]],
  ["valkey:8", "valkey://[::1]:49152", ["redis://[::1]:49152"]],
] as const)("preserves %s client URIs only for its declared listener", async (type, url, alternateUrls) => {
  const { connection: _connection, nonSqlCreds: _nonSqlCreds, sqlite: _sqlite, ...serviceBase } = web;
  const service: ServicePlan = {
    ...serviceBase,
    type,
    environment: { POSTGRES_USER: "wrong-user", POSTGRES_DB: "wrong-db", POSTGRES_PASSWORD: "canary" },
    ...(type.startsWith("postgres")
      ? {
          connection: {
            family: "postgres" as const,
            port: 15432,
            creds: { user: "db@user", database: "app/db", password: "canary" },
          },
        }
      : {}),
    endpoints: [
      { kind: "published", protocol: "tcp", port: 15432, primary: true, publication: { bindAddress: "::1" } },
      { kind: "internal", protocol: "tcp", port: 9000 },
    ],
  };
  const result = await infoOf(service, {
    publications: {
      status: "present",
      bindings: [
        { port: 15432, transport: "tcp", bindAddress: "::1", hostPort: 49152 },
        { port: 9000, transport: "tcp", bindAddress: "::1", hostPort: 19000 },
      ],
    },
  });
  expect(
    result.services[0]?.connections.find(
      (row) => row.source === "publication" && row.endpoint.port === 15432,
    ),
  ).toMatchObject({ url, alternateUrls });
  expect(
    result.services[0]?.connections.find((row) => row.source === "publication" && row.endpoint.port === 9000),
  ).toMatchObject({ url: "tcp://[::1]:19000", endpoint: { primary: false, names: [] } });
  expect(JSON.stringify(result)).not.toContain("canary");
});
