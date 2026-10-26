import { expect, test } from "bun:test";
import { type AppPlan, type PublicationObservation, ServiceInfo, type ServicePlan } from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
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
    readonly state?: string;
    readonly publications?: PublicationObservation;
    readonly routerEnabled?: boolean;
    readonly observedRoute?: boolean;
  } = {},
) => {
  const planned = {
    ...plan,
    services: { [service.name]: service },
    routes: [route],
    router: { enabled: options.routerEnabled ?? true },
  };
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed({
        app: planned.id,
        service: service.name,
        providerId: planned.provider,
        status: options.state ?? "running",
        publications: options.publications ?? { status: "unknown" as const },
      }),
  };
  const authority = { scheme: "https" as const, hostname: route.hostname, port: 38443 };
  return Effect.runPromise(
    infoForPlan(planned).pipe(
      Effect.provideService(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
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
              configuredAuthorities: [authority],
              observation:
                options.observedRoute === true
                  ? { status: "present" as const, publications: [{ route, authority }] }
                  : { status: "unknown" as const },
            }),
        }),
      ),
    ),
  );
};

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
    "connections",
    "primary",
    "provider",
    "service",
    "status",
    "type",
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

test.each(["stopped", "unknown", "paused", "restarting"])(
  "preserves the %s state vocabulary and configured route prefix",
  async (state) => {
    const result = await infoOf(web, { state, observedRoute: true });
    expect(result.services[0]?.status).toBe(state);
    expect(result.services[0]?.connections.find((row) => row.source === "route")).toMatchObject({
      url: "https://web.demo.lndo.site:38443/api",
      state: state === "unknown" || state === "restarting" ? "unknown" : "inactive",
    });
  },
);

test("retains disabled routes but never describes them as active", async () => {
  const result = await infoOf(web, { routerEnabled: false, observedRoute: true });
  expect(result.services[0]?.connections.find((row) => row.source === "route")).toMatchObject({
    state: "inactive",
    url: "https://web.demo.lndo.site:38443/api",
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
  const { connection: _connection, nonSqlCreds: _nonSqlCreds, ...serviceBase } = web;
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
      { _tag: "published", protocol: "tcp", port: 15432, primary: true, publication: { bindAddress: "::1" } },
      { _tag: "internal", protocol: "tcp", port: 9000 },
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
