import { Effect, Layer } from "effect";

import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import type { LandofileShape } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";

import { services } from "../../src/index.ts";

const providerCapabilities = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "native",
  hostReachability: "native",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "native",
  routeProvider: true,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  architectureEmulation: true,
  composeSpec: "native",
  providerExtensions: ["compose", "labels", "registryCredentials"],
} as const;

const registryLayer = Layer.merge(services, PluginRegistryLayer.layer);

export const planMysqlApp = (servicesInput: NonNullable<LandofileShape["services"]>) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan({ name: "mysql-versions", runtime: 4, services: servicesInput }, providerCapabilities),
    ).pipe(Effect.provide(AppPlannerLayer.layer), Effect.provide(registryLayer)),
  );
