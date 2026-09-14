import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { RouterServiceShape } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";

import { applyAppRoutes, routeUrlsForPlan } from "../../src/lifecycle/routes.ts";

const service = ServiceName.make("web");
const cachedPlan: AppPlan = {
  id: AppId.make("demo"),
  name: "demo",
  slug: "demo",
  root: AbsolutePath.make("/srv/apps/demo"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [
    {
      hostname: "demo.lndo.site",
      scheme: "https",
      service,
      backend: { service, protocol: "http", port: 8080 },
    },
  ],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00.000Z"),
    source: "routes.test",
    runtime: 4,
  },
  extensions: {},
};

describe("applyAppRoutes", () => {
  test("skips setup and route publication when the plan disables the router", async () => {
    // Given: declared routes and a conflicting Landofile must not override the plan.
    const plan: AppPlan = { ...cachedPlan, router: { enabled: false } };
    const calls: string[] = [];
    const proxy: RouterServiceShape = {
      ...makeTestRouterService(),
      setup: () => {
        calls.push("setup");
        expect.unreachable("disabled router must not run setup");
      },
      applyRoutes: () => {
        calls.push("applyRoutes");
        expect.unreachable("disabled router must not publish routes");
      },
      removeRoutes: () => Effect.sync(() => void calls.push("removeRoutes")),
    };

    // When
    const result = await Effect.runPromise(applyAppRoutes(proxy, plan, { enabled: true }));

    // Then
    expect(calls).toEqual(["removeRoutes"]);
    expect(result).toEqual({ app: plan.id, appliedRoutes: [], authorities: [] });
  });

  for (const [condition, plan] of [
    ["the cached plan omits router", cachedPlan],
    ["the plan enables the router", { ...cachedPlan, router: { enabled: true } }],
  ] as const) {
    test(`sets up before publishing routes when ${condition}`, async () => {
      // Given
      const base = makeTestRouterService();
      const calls: string[] = [];
      const proxy: RouterServiceShape = {
        ...base,
        setup: (config) =>
          Effect.sync(() => void calls.push("setup")).pipe(Effect.zipRight(base.setup(config))),
        applyRoutes: (routes, app) =>
          Effect.sync(() => void calls.push("applyRoutes")).pipe(
            Effect.zipRight(base.applyRoutes(routes, app)),
          ),
      };

      // When: enablement comes from the plan, not the Landofile.
      const result = await Effect.runPromise(applyAppRoutes(proxy, plan, { enabled: false }));

      // Then
      expect(calls).toEqual(["setup", "applyRoutes"]);
      expect(result).toEqual({
        app: plan.id,
        appliedRoutes: plan.routes,
        authorities: [{ scheme: "https", hostname: "demo.lndo.site", port: 38443 }],
      });
    });
  }
});

describe("routeUrlsForPlan", () => {
  test("returns an empty map without reading status when the plan disables the router", async () => {
    // Given
    const plan: AppPlan = { ...cachedPlan, router: { enabled: false } };
    const calls: string[] = [];
    const proxy: RouterServiceShape = {
      ...makeTestRouterService(),
      get status() {
        calls.push("status");
        return Effect.succeed({
          state: "running" as const,
          authorities: [{ scheme: "https" as const, hostname: "demo.lndo.site", port: 38443 }],
          configuredApps: [plan.id],
        });
      },
    };

    // When
    const urls = await Effect.runPromise(routeUrlsForPlan(proxy, plan));

    // Then
    expect(calls).toEqual([]);
    expect(urls).toEqual(new Map());
  });

  test("returns routed URLs when the plan enables the router", async () => {
    // Given
    const plan: AppPlan = { ...cachedPlan, router: { enabled: true } };
    const proxy: RouterServiceShape = {
      ...makeTestRouterService(),
      status: Effect.succeed({
        state: "running",
        authorities: [{ scheme: "https", hostname: "demo.lndo.site", port: 38443 }],
        configuredApps: [plan.id],
      }),
    };

    // When
    const urls = await Effect.runPromise(routeUrlsForPlan(proxy, plan));

    // Then
    expect(urls).toEqual(new Map([[service, ["https://demo.lndo.site:38443"]]]));
  });
});
