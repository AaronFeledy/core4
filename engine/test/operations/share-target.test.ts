import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";

import { defaultTunnelTarget } from "../../src/operations/share.ts";

const service = ServiceName.make("web");
const routedPlan: AppPlan = {
  id: AppId.make("share-demo"),
  name: "share-demo",
  slug: "share-demo",
  root: AbsolutePath.make("/srv/apps/share-demo"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [
    {
      hostname: "share-demo.lndo.site",
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
    resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00.000Z"),
    source: "share-target.test",
    runtime: 4,
  },
  extensions: {},
};

describe("defaultTunnelTarget", () => {
  test("shares the app itself when the plan disables the router", () => {
    // Given: a declared route that the disabled router never publishes.
    const plan: AppPlan = { ...routedPlan, router: { enabled: false } };
    // When
    const target = defaultTunnelTarget(plan);
    // Then
    expect(target).toEqual({ _tag: "route", routeId: plan.id });
  });

  for (const [condition, plan] of [
    ["the plan enables the router", { ...routedPlan, router: { enabled: true } }],
    ["a cached plan omits router", routedPlan],
  ] as const) {
    test(`shares the first route hostname when ${condition}`, () => {
      // When
      const target = defaultTunnelTarget(plan);
      // Then
      expect(target).toEqual({
        _tag: "route",
        routeId: "share-demo.lndo.site",
        hostname: "share-demo.lndo.site",
      });
    });
  }

  test("shares the app itself when no route exists", () => {
    // When
    const target = defaultTunnelTarget({ ...routedPlan, routes: [] });
    // Then
    expect(target).toEqual({ _tag: "route", routeId: routedPlan.id });
  });
});
