import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { ProxyError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RouterService, type RouterServiceShape } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";

import { applyAppRoutes } from "../../src/lifecycle/routes.ts";
import { collectObservedConnections, observeService } from "../../src/operations/connection-collector.ts";
import { web } from "../operations/start-progress-topology-support.ts";

const service = ServiceName.make("web");
const cachedPlan: AppPlan = {
  id: AppId.make("demo"),
  name: "demo",
  slug: "demo",
  root: AbsolutePath.make("/srv/apps/demo"),
  provider: ProviderId.make("lando"),
  services: {
    [service]: { ...web, name: service, endpoints: [{ _tag: "internal", protocol: "http", port: 8080 }] },
  },
  routes: [
    {
      hostname: "demo.lndo.site",
      priority: 2,
      scheme: "https",
      service,
      backend: { service, protocol: "http", port: 8080 },
    },
  ],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00.000Z"),
    source: "routes.test",
    runtime: 4,
  },
  extensions: {},
};

describe("applyAppRoutes", () => {
  test.each([false, true])(
    "withdraws routes without setup when the plan has no routes (cleanup fails: %s)",
    async (fails) => {
      // Given
      const plan: AppPlan = { ...cachedPlan, routes: [], router: { enabled: true } };
      const calls: AppPlan["id"][] = [];
      const proxy: RouterServiceShape = {
        ...makeTestRouterService(),
        setup: () => expect.unreachable("route-free app must not run setup"),
        applyRoutes: () => expect.unreachable("route-free app must not publish routes"),
        removeRoutes: (app) =>
          Effect.sync(() => void calls.push(app)).pipe(
            Effect.andThen(
              fails
                ? Effect.fail(
                    new ProxyError({
                      message: "router unavailable",
                      proxyId: "test",
                      remediation:
                        "Install or repair the `test` router plugin and ensure `defaultRouterService` points at an installed id.",
                    }),
                  )
                : Effect.void,
            ),
          ),
      };

      // When
      const result = await Effect.runPromise(applyAppRoutes(proxy, plan));

      // Then
      expect(calls).toEqual([plan.id]);
      expect(result).toEqual({ app: plan.id, appliedRoutes: [], authorities: [] });
    },
  );

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
          Effect.sync(() => void calls.push("setup")).pipe(Effect.andThen(base.setup(config))),
        applyRoutes: (routes, app) =>
          Effect.sync(() => void calls.push("applyRoutes")).pipe(
            Effect.andThen(base.applyRoutes(routes, app)),
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

describe("route connection collection", () => {
  test("retains inactive configured routes without reading status when the plan disables the router", async () => {
    // Given
    const plan: AppPlan = { ...cachedPlan, router: { enabled: false } };
    const calls: string[] = [];
    const proxy: RouterServiceShape = {
      ...makeTestRouterService(),
      observeRoutes: () =>
        Effect.succeed({
          configuredAuthorities: [{ scheme: "https", hostname: "demo.lndo.site", port: 38443 }],
          observation: { status: "unknown" },
        }),
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
    const rows = await Effect.runPromise(
      collectObservedConnections(plan, [
        observeService(plan, {
          app: plan.id,
          service,
          providerId: plan.provider,
          status: "running",
          publications: { status: "unknown" },
        }),
      ]).pipe(Effect.provideService(RouterService, proxy)),
    );

    // Then
    expect(calls).toEqual([]);
    expect(rows[0]?.connections.find((connection) => connection.source === "route")).toMatchObject({
      state: "inactive",
      url: "https://demo.lndo.site:38443",
    });
  });

  test("returns active routed connections only with matching live evidence", async () => {
    // Given
    const plan: AppPlan = { ...cachedPlan, router: { enabled: true } };
    const proxy: RouterServiceShape = {
      ...makeTestRouterService(),
      observeRoutes: () =>
        Effect.succeed({
          configuredAuthorities: [],
          observation: {
            status: "present",
            publications: plan.routes.map((route) => ({
              route,
              authority: { scheme: "https", hostname: "demo.lndo.site", port: 38443 },
            })),
          },
        }),
      status: Effect.succeed({
        state: "running",
        authorities: [{ scheme: "https", hostname: "demo.lndo.site", port: 38443 }],
        configuredApps: [plan.id],
      }),
    };

    // When
    const rows = await Effect.runPromise(
      collectObservedConnections(plan, [
        observeService(plan, {
          app: plan.id,
          service,
          providerId: plan.provider,
          status: "running",
          publications: { status: "unknown" },
        }),
      ]).pipe(Effect.provideService(RouterService, proxy)),
    );

    // Then
    expect(rows[0]?.connections.find((connection) => connection.source === "route")).toMatchObject({
      state: "active",
      url: "https://demo.lndo.site:38443",
    });
  });
});
