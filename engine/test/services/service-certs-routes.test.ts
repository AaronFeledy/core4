import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { planAppPlannerCerts } from "./app-planner-certs-harness.ts";

for (const routes of [{ routes: [] }, { proxy: { web: [] } }]) {
  test(`omits the generated route SAN when ${"routes" in routes ? "service" : "proxy"} routes are explicitly empty`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-certs-route-opt-out-"));
    try {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "certs-app",
        services: {
          web: { type: "node:22", certs: true, ...("routes" in routes ? { routes: routes.routes } : {}) },
        },
        ...("proxy" in routes ? { proxy: routes.proxy } : {}),
      });
      // When
      const result = await planAppPlannerCerts({
        appRoot: root,
        cacheRoot: join(root, "cache"),
        landofile,
      });
      // Then
      expect(result.routes).toEqual([]);
      expect(result.services[ServiceName.make("web")]?.certs?.sans).toEqual([
        "web",
        "web.certs-app.internal",
        "localhost",
        "127.0.0.1",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("derives SANs from normalized shorthand hostnames", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-certs-routes-"));
  try {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "certs-app",
      services: { web: { type: "node:22", certs: true, routes: ["web.example.test:3000/api"] } },
      proxy: { web: ["alias.example.test:3000/other"] },
    });
    // When
    const result = await planAppPlannerCerts({
      appRoot: root,
      cacheRoot: join(root, "cache"),
      landofile,
    });
    // Then
    const sans = [
      "web",
      "web.certs-app.internal",
      "web.example.test",
      "alias.example.test",
      "localhost",
      "127.0.0.1",
    ];
    expect(result.services[ServiceName.make("web")]?.certs?.sans).toEqual(sans);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
