import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { providerLandoCapabilitiesForPlatform } from "@lando/provider-lando";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";

import traefikGlobalService from "../../../plugins/proxy-traefik/src/global-services/traefik.ts";
import { deepMerge } from "../../src/config/overlay.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

describe("global Traefik endpoint planning", () => {
  test("keeps semantic web endpoints without inferred TCP duplicates", async () => {
    // Given
    const traefik = await Effect.runPromise(traefikGlobalService);
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "global",
      services: { traefik },
    });

    // When
    const plan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(landofile, providerLandoCapabilitiesForPlatform("linux"), { kind: "global" }),
      ).pipe(Effect.provide(AppPlannerLive), Effect.provide(PluginRegistryLive)),
    );

    // Then
    expect(plan.services[ServiceName.make("traefik")]?.endpoints).toEqual([
      { name: "web", protocol: "http", port: 80, bind: "127.0.0.1", publishedPort: 38080 },
      {
        name: "websecure",
        protocol: "https",
        port: 443,
        bind: "127.0.0.1",
        publishedPort: 38443,
      },
    ]);
  });

  test("overlay replacement preserves endpoint protocol identity while changing publication", async () => {
    // Given
    const traefik = await Effect.runPromise(traefikGlobalService);
    const generated = { services: { traefik } };
    const overlay = {
      services: {
        traefik: {
          endpoints: [
            { name: "web", protocol: "http", port: 80, publishedPort: 48080 },
            { name: "websecure", protocol: "https", port: 443, publishedPort: 48443 },
          ],
        },
      },
    };

    // When
    const merged = Schema.decodeUnknownSync(LandofileShape)(deepMerge(generated, overlay));

    // Then
    expect(merged.services?.[ServiceName.make("traefik")]?.endpoints).toEqual([
      { name: "web", protocol: "http", port: 80, publishedPort: 48080 },
      { name: "websecure", protocol: "https", port: 443, publishedPort: 48443 },
    ]);
  });
});
