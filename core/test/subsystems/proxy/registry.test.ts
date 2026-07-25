import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ProxyService, type ProxyServiceShape } from "@lando/sdk/services";

import {
  type ProxyServiceRegistration,
  makeProxyServiceRegistry,
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

describe("ProxyService registry selection", () => {
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
