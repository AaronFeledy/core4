import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

const planService = async (service: Record<string, unknown>) => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-listeners-"));
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const landofile = yield* compileTestLandofile(
          { name: "listeners", services: { web: service } },
          appRoot,
        );
        const registry = yield* PluginRegistry;
        return yield* planApp(
          { landofile, providerCapabilities: TestRuntimeProvider.capabilities, appRoot },
          Layer.succeed(PluginRegistry, registry),
        );
      }).pipe(Effect.provide(PluginRegistryLayer.layer), Effect.provide(BunFileSystem.layer)),
    );
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
};

test.each([
  { routes: [{ hostname: "console.test", endpoint: "console" }], port: 19001 },
  { routes: undefined, port: 9001 },
])("MinIO planner routes selected console or default API: %j", async ({ routes, port }) => {
  // Given / When
  const plan = await planService({
    type: "minio",
    image: "example.test/minio:fixture",
    port: 9001,
    consolePort: 19001,
    ...(routes === undefined ? {} : { routes }),
  });
  // Then
  expect(plan.routes).toEqual([
    expect.objectContaining({ backend: { service: "web", protocol: "http", port } }),
  ]);
});

test("explicit empty endpoints remain authoritative for MinIO", async () => {
  // Given / When
  const plan = await planService({
    type: "minio",
    image: "example.test/minio:fixture",
    consolePort: 19001,
    endpoints: [],
    routes: [],
  });
  // Then
  expect(plan.services[ServiceName.make("web")]?.endpoints).toEqual([]);
  expect(plan.routes).toEqual([]);
});

test.each(["ui", "api"])("MailHog planner routes explicitly selected %s listener", async (endpoint) => {
  // Given / When
  const plan = await planService({
    type: "mailhog",
    environment: { MH_UI_BIND_ADDR: ":18025", MH_API_BIND_ADDR: ":18026" },
    routes: [{ hostname: "mail.test", endpoint }],
  });
  // Then
  expect(plan.routes[0]?.backend.port).toBe(endpoint === "ui" ? 18025 : 18026);
});

test("MailHog split HTTP listeners require explicit route selection", async () => {
  // Given / When / Then
  await expect(
    planService({ type: "mailhog", environment: { MH_UI_BIND_ADDR: ":18025", MH_API_BIND_ADDR: ":18026" } }),
  ).rejects.toMatchObject({
    _tag: "LandofileValidationError",
    issues: [
      expect.objectContaining({
        path: ["services", "web", "routes"],
        message: expect.stringContaining("ambiguous between HTTP listeners"),
      }),
    ],
  });
});

test("numeric routes share a listener and classify only the TCP publication", async () => {
  const plan = await planService({
    type: "compose",
    image: "traefik/whoami:v1.10",
    ports: [
      { target: 8080, published: "18080", host_ip: "127.0.0.1", name: "web", app_protocol: "http" },
      "18081:8080/udp",
    ],
    expose: [8081],
    routes: [
      "web.lndo.site:8080",
      { hostname: "both.lndo.site", endpoint: 8080, scheme: "both" },
      { hostname: "side.lndo.site", endpoint: "{{ 8081 }}" },
    ],
  });
  const scan = { okCodes: [], path: "/" };
  expect(plan.services[ServiceName.make("web")]?.endpoints).toEqual([
    { kind: "internal", protocol: "http", port: 8080, scan },
    { kind: "internal", protocol: "http", port: 8081, scan },
    {
      kind: "published",
      protocol: "http",
      port: 8080,
      name: "web",
      appProtocol: "http",
      publication: { hostPort: 18080, bindAddress: "127.0.0.1" },
      scan,
    },
    { kind: "published", protocol: "udp", port: 8080, publication: { hostPort: 18081 } },
  ]);
  expect(
    plan.routes.map(({ hostname, scheme, backend }) => [hostname, scheme, backend.protocol, backend.port]),
  ).toEqual([
    ["web.lndo.site", "https", "http", 8080],
    ["both.lndo.site", "http", "http", 8080],
    ["both.lndo.site", "https", "http", 8080],
    ["side.lndo.site", "https", "http", 8081],
  ]);
});

test.each(["lando", "compose"])(
  "%s self port leaves numeric HTTP route endpoints unchanged",
  async (type) => {
    const plan = await planService({
      type,
      image: "traefik/whoami:v1.10",
      port: 8080,
      command: ["/whoami", "--port", "{{ service.port }}"],
      endpoints: [],
      routes: [{ hostname: "web.lndo.site", endpoint: 8080, scheme: "http" }],
    });

    expect(plan.routes).toEqual([
      expect.objectContaining({ backend: { service: "web", protocol: "http", port: 8080 } }),
    ]);
    expect(plan.services[ServiceName.make("web")]?.endpoints).toEqual([
      { kind: "internal", protocol: "http", port: 8080, scan: { okCodes: [], path: "/" } },
    ]);
  },
);

test("retains a Node application listener and declares a numeric secondary", async () => {
  const plan = await planService({
    type: "node:22",
    port: 3000,
    routes: ["node.lndo.site:3000", "secondary.lndo.site:8080"],
  });
  expect(
    plan.services[ServiceName.make("web")]?.endpoints.map((facet) =>
      facet.protocol === "unix" ? [facet.socketPath, facet.protocol] : [facet.port, facet.protocol],
    ),
  ).toEqual([
    [3000, "http"],
    [8080, "http"],
  ]);
  expect(plan.routes.map(({ backend }) => backend.port)).toEqual([3000, 8080]);
});

test("clearing endpoints does not turn PHP-FPM into HTTP", async () => {
  await expect(
    planService({ type: "php:8.3", via: "fpm", endpoints: [], routes: ["fpm.lndo.site:9000"] }),
  ).rejects.toMatchObject({
    _tag: "LandofileValidationError",
    issues: [
      expect.objectContaining({
        path: ["services", "web", "routes", 0],
        message: expect.stringMatching(/9000.*tcp/i),
      }),
    ],
  });
});
