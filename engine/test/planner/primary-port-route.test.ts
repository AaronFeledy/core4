import { expect, test } from "bun:test";
import { PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

for (const type of ["nginx", "node:22"]) {
  test.each([
    { scenario: "only a secondary port is published", ports: ["13188:3188"] },
    { scenario: "the primary publication follows a secondary", ports: ["13188:3188", "13187:3187"] },
    { scenario: "UDP shares the primary port number", ports: ["13187:3187/udp", "13188:3188"] },
    { scenario: "publications are explicitly empty", ports: [] },
  ])(`${type} default route targets the primary listener when $scenario`, async ({ ports }) => {
    // Given
    const landofile = await Effect.runPromise(
      compileTestLandofile(
        {
          name: "primary-port",
          services: { web: { type, port: 3187, ports, home: false } },
        },
        "/srv/apps/primary-port",
      ),
    );
    // When
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry;
        return yield* planApp(
          {
            landofile,
            providerCapabilities: TestRuntimeProvider.capabilities,
            appRoot: "/srv/apps/primary-port",
          },
          Layer.succeed(PluginRegistry, registry),
        );
      }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(plan.routes).toEqual([
      expect.objectContaining({
        hostname: "web.primary-port.lndo.site",
        backend: { service: "web", protocol: "http", port: 3187 },
      }),
    ]);
  });
}
