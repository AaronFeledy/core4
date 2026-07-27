import { describe, expect, test } from "bun:test";
import { Effect, Either, Layer, Schema } from "effect";

import { ProxyError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { GlobalConfig, PluginManifest } from "@lando/sdk/schema";
import { ConfigService, ProxyService, type ProxyServiceShape } from "@lando/sdk/services";

import {
  type ProxyServiceRegistration,
  ProxyServiceRegistry,
  makeProxyServiceRegistry,
  makeProxyServiceRegistryLive,
} from "../../../src/subsystems/proxy/registry.ts";

const service = (id: string): ProxyServiceShape => ({
  id,
  capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
  setup: () => Effect.void,
  applyRoutes: (routes, app) => Effect.succeed({ app, appliedRoutes: routes, authorities: [] }),
  removeRoutes: () => Effect.void,
  status: Effect.succeed({ state: "running", authorities: [], configuredApps: [] }),
  stop: Effect.void,
});

const registration = (
  id: string,
  defaultFor?: ProxyServiceRegistration["defaultFor"],
): ProxyServiceRegistration => ({
  id,
  layer: Layer.succeed(ProxyService, service(id)),
  ...(defaultFor === undefined ? {} : { defaultFor }),
});

const config = Schema.decodeSync(GlobalConfig)({});
const configLayer = Layer.succeed(ConfigService, {
  load: Effect.succeed(config),
  get: (key) => Effect.succeed(config[key]),
});

const proxyModule = (id: string, layer: ProxyServiceRegistration["layer"]): LandoPluginModule => ({
  name: "@lando/proxy-test",
  manifest: Schema.decodeSync(PluginManifest)({
    name: "@lando/proxy-test",
    version: "1.0.0",
    api: 4,
    contributes: { proxyServices: [{ id, module: "./proxy.ts" }] },
  }),
  proxyServices: new Map([[id, layer]]),
});

const runInjectedSelection = (modules: ReadonlyArray<LandoPluginModule>, explicit: string) =>
  Effect.runPromise(
    Effect.flatMap(ProxyServiceRegistry, (registry) => registry.select({ explicit })).pipe(
      Effect.provide(makeProxyServiceRegistryLive(modules).pipe(Layer.provide(configLayer))),
      Effect.either,
    ),
  );

describe("ProxyService registry selection", () => {
  test("resolves an id from an injected plugin descriptor module", async () => {
    // Given: an injected descriptor module with one static ProxyService layer.
    const fakeLayer = Layer.succeed(ProxyService, service("fake"));

    // When: the descriptor-backed registry resolves its contributed id.
    const result = await runInjectedSelection([proxyModule("fake", fakeLayer)], "fake");

    // Then: the descriptor's exact layer is selected.
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right.layer).toBe(fakeLayer);
  });

  test("preserves the typed selection error for an id absent from injected modules", async () => {
    // Given: an injected descriptor module that contributes only the fake id.
    const fakeLayer = Layer.succeed(ProxyService, service("fake"));

    // When: a different id is selected explicitly.
    const result = await runInjectedSelection([proxyModule("fake", fakeLayer)], "missing");

    // Then: selection fails through the existing ProxyError path.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ProxyError);
      expect(result.left.proxyId).toBe("missing");
      expect(result.left.message).toBe("Proxy service missing is not installed.");
    }
  });

  test("selects the sole bundled default", async () => {
    const registry = makeProxyServiceRegistry({
      registrations: [registration("traefik")],
      configured: Effect.succeed(undefined),
      platform: "linux",
    });

    const selected = await Effect.runPromise(registry.select());

    expect(selected.id).toBe("traefik");
  });

  test("explicit test contribution overrides a bundled default", async () => {
    const registry = makeProxyServiceRegistry({
      registrations: [registration("traefik", { platform: ["linux"] }), registration("test")],
      configured: Effect.succeed("traefik"),
      platform: "linux",
    });

    const selected = await Effect.runPromise(registry.select({ explicit: "test" }));

    expect(selected.id).toBe("test");
  });

  test("global config wins before manifest defaults", async () => {
    const registry = makeProxyServiceRegistry({
      registrations: [registration("traefik", { platform: ["linux"] }), registration("remote")],
      configured: Effect.succeed("remote"),
      platform: "linux",
    });

    const selected = await Effect.runPromise(registry.select());

    expect(selected.id).toBe("remote");
  });
});
