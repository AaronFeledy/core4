import { describe, expect, test } from "bun:test";
import { RouteProviderMismatchError } from "@lando/sdk/errors";
import { LandofileShape, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { HostProviderOverride } from "../../src/providers/host-provider.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

const plan = (input: unknown, hostProvider: string) =>
  Effect.flatMap(AppPlanner, (planner) =>
    planTestLandofile(
      planner,
      Schema.decodeUnknownSync(LandofileShape)(input),
      TestRuntimeProvider.capabilities,
    ),
  ).pipe(
    Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer))),
    Effect.provideService(HostProviderOverride, ProviderId.make(hostProvider)),
  );

describe("route provider placement", () => {
  test.each([{ routes: undefined }, { routes: ["web.example.test"] }])(
    "rejects cross-provider routing with routes %j",
    async ({ routes }) => {
      // Given: both generated and authored routes require the host router.
      const input = {
        name: "route-provider",
        provider: "docker",
        services: { web: { type: "nginx", home: false, ...(routes === undefined ? {} : { routes }) } },
      };
      // When
      const result = await Effect.runPromise(plan(input, "lando").pipe(Effect.result));
      // Then
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(RouteProviderMismatchError);
        if (result.failure instanceof RouteProviderMismatchError) {
          expect(result.failure.providerId).toBe(ProviderId.make("docker"));
          expect(result.failure.hostProviderId).toBe(ProviderId.make("lando"));
          expect(result.failure.remediation).toContain("lando setup --provider=docker");
          expect(result.failure.remediation).toContain("provider:");
          expect(result.failure.remediation).toContain("router.enabled: false");
        }
      }
    },
  );

  test.each([{ routes: [] }, { router: { enabled: false } }])(
    "accepts a cross-provider app with %j",
    async (options) => {
      // Given
      const input = {
        name: "route-provider",
        provider: "docker",
        ...("router" in options ? { router: options.router } : {}),
        services: {
          web: { type: "nginx", home: false, ...("routes" in options ? { routes: options.routes } : {}) },
        },
      };
      // When
      const result = await Effect.runPromise(plan(input, "lando"));
      // Then: HTTP endpoints never become implicit host publications.
      expect(result.provider).toBe(ProviderId.make("docker"));
      expect(result.services[ServiceName.make("web")]?.endpoints).toMatchObject([
        { _tag: "internal", port: 80 },
      ]);
      expect(
        result.services[ServiceName.make("web")]?.endpoints.every((endpoint) => endpoint._tag === "internal"),
      ).toBe(true);
    },
  );

  test.each(["lando", "docker"])("keeps same-provider %s routes internal", async (provider) => {
    // Given
    const input = { name: "route-provider", provider, services: { web: { type: "nginx", home: false } } };
    // When
    const result = await Effect.runPromise(plan(input, provider));
    // Then
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.backend).toEqual({
      service: ServiceName.make("web"),
      protocol: "http",
      port: 80,
    });
    expect(
      result.services[ServiceName.make("web")]?.endpoints.every((endpoint) => endpoint._tag === "internal"),
    ).toBe(true);
    expect(result.networking?.sharedNetworkMembership?.aliases[ServiceName.make("web")]).toContain(
      "web.route-provider.internal",
    );
  });
});
import { planTestLandofile } from "../compiled-landofile.ts";
