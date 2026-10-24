import { expect, test } from "bun:test";
import { definePlugin } from "@lando/sdk/plugins";
import { AppPlan, type EndpointPlan, PluginManifest, ServiceName } from "@lando/sdk/schema";
import { type AppFeatureDefinition, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { bundledPluginModules } from "../../src/composition.ts";
import { planApp } from "../../src/planner/assemble.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

const lateHttp: AppFeatureDefinition = {
  id: "test.late-http",
  priority: 100,
  selectors: { names: ["web"] },
  apply: (ctx) =>
    Effect.sync(() =>
      ctx.forEachSelected((service) => {
        service.addEndpoint({
          _tag: "internal",
          protocol: "http",
          port: 7000,
          name: "late",
          ...(service.service.connection === undefined ? { primary: true } : {}),
        });
        if (service.service.connection !== undefined)
          service.addEnv("CLIENT_PASSWORD", service.service.connection.creds.password);
      }),
    ),
};
const plugin = definePlugin({
  name: "@example/late-http",
  manifest: Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/late-http",
    version: "1.0.0",
    api: 4,
    entry: "index.js",
    contributes: { appFeatures: [lateHttp.id], serviceTypes: ["endpoint-postgres"] },
  }),
  appFeatures: new Map([[lateHttp.id, lateHttp]]),
  serviceTypes: new Map([
    [
      "endpoint-postgres",
      {
        id: "endpoint-postgres",
        name: "Endpoint PostgreSQL",
        base: "lando",
        extends: "postgres",
        schema: Schema.Unknown,
        resolve: () => Effect.succeed({ base: "lando", normalizedConfig: {}, features: [] }),
      },
    ],
  ]),
});
const plan = (service: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    return yield* planApp(
      registry,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      yield* compileTestLandofile(
        {
          name: "endpoint-replay",
          services: { web: { home: false, ...service } },
        },
        "/srv/endpoint-replay",
      ),
      TestRuntimeProvider.capabilities,
      "/srv/endpoint-replay",
    );
  }).pipe(
    Effect.provide(
      PluginRegistryLayer.layerWith({ app: false, user: false }, [...bundledPluginModules(), plugin]),
    ),
  );

test("classifies an earlier publication from a late app-feature HTTP declaration", async () => {
  // Given
  const service = { type: "compose", image: "alpine:3", ports: ["17000:7000"] };
  // When
  const result = await Effect.runPromise(plan(service));
  // Then
  expect(result.services[ServiceName.make("web")]?.endpoints).toEqual([
    { _tag: "internal", protocol: "http", port: 7000, name: "late", primary: true },
    {
      _tag: "published",
      protocol: "http",
      port: 7000,
      name: "late",
      primary: true,
      publication: { hostPort: 17000 },
    },
  ]);
  expect(result.routes[0]?.backend).toEqual({
    service: ServiceName.make("web"),
    protocol: "http",
    port: 7000,
  });
});

test("retains typed credentials and exact declaration identity while replaying late endpoint contributions", async () => {
  // Given
  const service = {
    type: "endpoint-postgres",
    creds: { user: "app", database: "app", password: "${secret:ENDPOINT_DB}" },
    ports: ["17000:7000", "15432:5432"],
  };
  // When
  const result = await Effect.runPromise(plan(service));
  const persisted = Schema.decodeUnknownSync(AppPlan)(
    JSON.parse(JSON.stringify(Schema.encodeSync(AppPlan)(result))),
    { onExcessProperty: "error" },
  );
  // Then
  const database = persisted.services[ServiceName.make("web")];
  expect(database?.type).toBe("postgres");
  expect(database?.serviceTypeId).toBe("endpoint-postgres");
  expect(database?.connection).toMatchObject({
    family: "postgres",
    port: 5432,
    creds: { password: { _tag: "SecretRef", reference: "ENDPOINT_DB" } },
  });
  expect(database?.environment.CLIENT_PASSWORD).toEqual({ _tag: "SecretRef", reference: "ENDPOINT_DB" });
  expect(database?.endpoints).toContainEqual({
    _tag: "published",
    protocol: "http",
    port: 7000,
    name: "late",
    publication: { hostPort: 17000 },
  });
  expect(database?.endpoints).toContainEqual({
    _tag: "internal",
    protocol: "tcp",
    port: 5432,
    name: "web",
    primary: true,
  });
  expect(database?.endpoints).toContainEqual({
    _tag: "published",
    protocol: "tcp",
    port: 5432,
    name: "web",
    primary: true,
    publication: { hostPort: 15432 },
  });
});

test.each([{ endpoints: [] }, { endpoints: [{ _tag: "internal", protocol: "http", port: 8000 }] }])(
  "replays explicit endpoint authority after app features: %j",
  async ({ endpoints }) => {
    // Given
    const service = { type: "compose", image: "alpine:3", ports: ["17000:7000"], expose: [9000], endpoints };
    // When
    const result = await Effect.runPromise(plan(service));
    // Then
    expect(result.services[ServiceName.make("web")]?.endpoints).toEqual(endpoints);
    expect(result.routes.map((route) => route.backend.port)).toEqual(
      endpoints.map((endpoint) => endpoint.port),
    );
  },
);

test("emits byte-identical endpoint and route inputs on repeated planning", async () => {
  // Given
  const service = { type: "compose", image: "alpine:3", ports: ["17000:7000", "17000:7000"] };
  // When
  const results = await Promise.all([Effect.runPromise(plan(service)), Effect.runPromise(plan(service))]);
  // Then
  expect(
    results
      .map((result) =>
        JSON.stringify({
          endpoints: result.services[ServiceName.make("web")]?.endpoints,
          routes: result.routes,
        }),
      )
      .every((bytes, _index, all) => bytes === all[0]),
  ).toBe(true);
  expect(results[0]?.services[ServiceName.make("web")]?.endpoints).toHaveLength(2);
});

test.each([
  {
    label: "aliases across TCP and UDP",
    endpoints: [
      { _tag: "internal", protocol: "tcp", port: 80, name: "same" },
      { _tag: "internal", protocol: "udp", port: 80, name: "same" },
    ],
  },
  {
    label: "aliases across Unix and TCP",
    endpoints: [
      { _tag: "internal", protocol: "unix", socketPath: "/run/app.sock", name: "same" },
      { _tag: "internal", protocol: "tcp", port: 80, name: "same" },
    ],
  },
  {
    label: "conflicting listener protocols",
    endpoints: [
      { _tag: "internal", protocol: "http", port: 80 },
      { _tag: "internal", protocol: "tcp", port: 80 },
    ],
  },
  {
    label: "distinct primary listeners",
    endpoints: [
      { _tag: "internal", protocol: "http", port: 80, primary: true },
      { _tag: "internal", protocol: "http", port: 90, primary: true },
    ],
  },
])("reports $label at the service endpoint field", async ({ endpoints }) => {
  // Given
  const service = { type: "compose", image: "alpine:3", endpoints };
  // When
  const result = await Effect.runPromise(Effect.result(plan(service)));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "LandofileValidationError",
      issues: [{ path: ["services", "web", "endpoints"] }],
      remediation: expect.any(String),
    });
});

test("rejects unselected ambiguous HTTP listeners instead of using list order", async () => {
  // Given
  const endpoints: readonly EndpointPlan[] = [
    { _tag: "internal", protocol: "http", port: 80 },
    { _tag: "internal", protocol: "http", port: 90 },
  ];
  // When
  const result = await Effect.runPromise(
    Effect.result(plan({ type: "compose", image: "alpine:3", endpoints })),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "LandofileValidationError",
      issues: [{ path: ["services", "web", "routes"] }],
    });
});
