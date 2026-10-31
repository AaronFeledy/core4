import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

const planService = async (service: Record<string, unknown>) => {
  const landofile = await Effect.runPromise(
    compileTestLandofile({ name: "listeners", services: { web: service } }, "/srv/apps/listeners"),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      return yield* planApp(
        { landofile, providerCapabilities: TestRuntimeProvider.capabilities, appRoot: "/srv/apps/listeners" },
        Layer.succeed(PluginRegistry, registry),
      );
    }).pipe(Effect.provide(PluginRegistryLayer.layer)),
  );
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
