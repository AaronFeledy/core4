import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { AppPlanner, PluginRegistry } from "@lando/core/services";
import { AppPlan, type LandofileShape, ProviderId, ServiceName } from "@lando/sdk/schema";

import { PluginRegistryLive } from "../../../core/src/plugins/registry.ts";
import { AppPlannerLive } from "../../../core/src/services/planner.ts";
import { services } from "../src/index.ts";

const providerCapabilities = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "native",
  hostReachability: "native",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "native",
  routeProvider: true,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "native",
  providerExtensions: ["compose", "labels", "registryCredentials"],
} as const;

const registryLayer = Layer.merge(services, PluginRegistryLive);

const plan = (landofile: LandofileShape) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (appPlanner) => appPlanner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(registryLayer),
    ),
  );

describe("@lando/service-lando registration", () => {
  test("loads both service type contributions from PluginRegistry", async () => {
    const manifest = await Effect.runPromise(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@lando/service-lando")).pipe(
        Effect.provide(registryLayer),
      ),
    );

    if (manifest.contributes === undefined) throw new Error("service-lando manifest contributions missing");
    expect(manifest.contributes.serviceTypes).toEqual(["node:lts", "postgres"]);
  });

  test("AppPlanner resolves both service types through PluginRegistry", async () => {
    const appPlan = await plan({
      name: "registry-app",
      runtime: 4,
      services: {
        [ServiceName.make("web")]: { type: "node:lts" },
        [ServiceName.make("db")]: { type: "postgres" },
      },
    });

    const encoded = Schema.encodeSync(AppPlan)(appPlan);
    expect(Schema.decodeUnknownEither(AppPlan)(encoded)._tag).toBe("Right");
    expect(appPlan.provider).toBe(ProviderId.make("lando"));
    expect(appPlan.services[ServiceName.make("web")]?.type).toBe("node:lts");
    expect(appPlan.services[ServiceName.make("db")]?.type).toBe("postgres");
  });
});
