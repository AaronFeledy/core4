import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";

import {
  HOST_INTERNAL_ALIAS,
  rewriteCrossEngineProxyRoutes,
} from "../../src/lifecycle/cross-engine-routes.ts";
import { MANAGED_PROVIDER_ID } from "../../src/providers/managed.ts";

const plan = (provider: string): AppPlan => ({
  id: AppId.make("shop"),
  name: "shop",
  slug: "shop",
  root: AbsolutePath.make("/tmp/shop"),
  provider: ProviderId.make(provider),
  services: {},
  routes: [
    {
      hostname: "web.shop.lndo.site",
      scheme: "https",
      service: ServiceName.make("web"),
      backend: { service: ServiceName.make("web"), protocol: "http", port: 80 },
    },
  ],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("1970-01-01T00:00:00.000Z"),
    source: "test",
    runtime: 4,
  },
  extensions: {},
});

describe("rewriteCrossEngineProxyRoutes", () => {
  test("keeps .internal backends when the app shares the managed Traefik engine", () => {
    const rewritten = rewriteCrossEngineProxyRoutes({
      plan: plan(String(MANAGED_PROVIDER_ID)),
      published: [{ service: "web", containerPort: 80, hostPort: 32768 }],
    });

    expect(rewritten[0]?.backend).toEqual({
      service: ServiceName.make("web"),
      protocol: "http",
      port: 80,
    });
  });

  test("points docker-app routes at the host gateway published port", () => {
    const rewritten = rewriteCrossEngineProxyRoutes({
      plan: plan("docker"),
      published: [{ service: "web", containerPort: 80, hostPort: 32768 }],
    });

    expect(rewritten[0]?.backend).toEqual({
      service: ServiceName.make("web"),
      protocol: "http",
      port: 32768,
      host: HOST_INTERNAL_ALIAS,
    });
    expect(String(MANAGED_PROVIDER_ID)).toBe("lando");
  });
});
