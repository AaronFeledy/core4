import { expect, test } from "bun:test";
import { LandofileShape } from "@lando/sdk/schema";
import { PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { planApp } from "../../src/planner/assemble.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

for (const type of ["nginx", "node:22"]) {
  test.each([
    { scenario: "only a secondary port is published", ports: ["13188:3188"] },
    { scenario: "the primary publication follows a secondary", ports: ["13188:3188", "13187:3187"] },
    { scenario: "UDP shares the primary port number", ports: ["13187:3187/udp", "13188:3188"] },
    { scenario: "publications are explicitly empty", ports: [] },
  ])(`${type} default route targets the primary listener when $scenario`, async ({ ports }) => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "primary-port",
      services: { web: { type, port: 3187, ports, home: false } },
    });
    // When
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry;
        return yield* planApp(
          registry,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          landofile,
          TestRuntimeProvider.capabilities,
          "/srv/apps/primary-port",
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
