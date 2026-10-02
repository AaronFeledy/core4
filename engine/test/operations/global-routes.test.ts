import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { RouterServiceShape } from "@lando/sdk/services";

import { applyGlobalRoutesForSelectedServices } from "../../src/operations/global-routes.ts";

const mail = ServiceName.make("mailpit");
const plan: AppPlan = {
  id: AppId.make("global"),
  name: "global",
  slug: "global",
  root: AbsolutePath.make("/tmp/lando-global"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [
    {
      hostname: "mailpit.lndo.site",
      priority: 1,
      scheme: "https",
      service: mail,
      endpoint: 8025,
      backend: { service: mail, protocol: "http", port: 8025 },
    },
  ],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-09-22T00:00:00Z"),
    source: "global-routes.test",
    runtime: 4,
  },
  extensions: {},
};

describe("global route selection", () => {
  test("starting a global service without routes does not set up Traefik or replace its route file", async () => {
    const router = {
      setup: () => Effect.die("Traefik setup must not recur while Traefik itself starts"),
      applyRoutes: () => Effect.die("Unrelated routes must not be applied"),
    } as unknown as RouterServiceShape;

    const urls = await Effect.runPromise(
      applyGlobalRoutesForSelectedServices(router, plan, new Set(["traefik"])),
    );
    expect(urls.size).toBe(0);
  });
});
