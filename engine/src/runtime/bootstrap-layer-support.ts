import { type Context, Effect, type Layer, Schema, Stream } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type LogLevel, ProviderCapabilities, type ResolvedPluginInput } from "@lando/sdk/schema";
import { Renderer, RuntimeProvider } from "@lando/sdk/services";

import type { LoggerMode } from "../logging/service.ts";
import type { BootstrapLifecycleTracker } from "./bootstrap-lifecycle.ts";
import type { RuntimeLayerFactory } from "./runtime-layer-factory.ts";

export type LibraryRendererMode = "json" | "plain" | "verbose" | "lando";

export interface BootstrapLayerPluginDiscovery {
  readonly bundled: boolean;
  readonly system: boolean;
  readonly user: boolean;
  readonly app: boolean;
  readonly disable: ReadonlyArray<string>;
}

export interface BootstrapLayerInputs {
  readonly runtimeLayerFactory: Context.Service.Shape<typeof RuntimeLayerFactory>;
  readonly lifecycle: BootstrapLifecycleTracker;
  readonly loggerMode: LoggerMode;
  readonly logLevel: LogLevel | undefined;
  readonly structured: boolean;
  readonly writeDiagnosticLine?: (line: string) => void;
  readonly stderrIsTTY?: boolean;
  readonly rendererMode: LibraryRendererMode;
  readonly telemetryEnabled: boolean;
  readonly pluginDiscovery: BootstrapLayerPluginDiscovery;
  readonly pluginLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>;
  readonly pluginManifests: ReadonlyArray<ResolvedPluginInput>;
  readonly externalImports: boolean;
  readonly cwd: string;
  readonly configInputs: import("../services/config.ts").GlobalConfigSources["Service"];
}

const providerCapabilities = Schema.decodeUnknownSync(ProviderCapabilities)({
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: false,
  serviceExec: false,
  serviceLogs: false,
  serviceLogSources: false,
  serviceHealth: "none",
  hostReachability: "none",
  sharedCrossAppNetwork: false,
  persistentStorage: false,
  bindMounts: false,
  bindMountPerformance: "none",
  copyMounts: false,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "none",
  routeProvider: false,
  tlsCertificates: "none",
  rootless: true,
  privilegedServices: false,
  composeSpec: "none",
  providerExtensions: [],
});

const unsupportedProviderOperation = (operation: string) =>
  new ProviderUnavailableError({
    providerId: "stub",
    operation,
    message: `runtime provider stub cannot ${operation}`,
    remediation: `Select the target app's provider through RuntimeProviderRegistry.select(plan) before calling ${operation}; run lando setup if that provider is not installed.`,
  });

export const runtimeProviderService: Context.Service.Shape<typeof RuntimeProvider> = RuntimeProvider.of({
  id: "stub",
  displayName: "Stub Runtime Provider",
  version: "0.0.0",
  platform: "linux",
  capabilities: providerCapabilities,
  isAvailable: Effect.succeed(false),
  planSetup: () => Effect.fail(unsupportedProviderOperation("planSetup")),
  setup: () => Effect.fail(unsupportedProviderOperation("setup")),
  getStatus: Effect.fail(unsupportedProviderOperation("getStatus")),
  getVersions: Effect.fail(unsupportedProviderOperation("getVersions")),
  buildArtifact: () => Effect.fail(unsupportedProviderOperation("buildArtifact")),
  pullArtifact: () => Effect.fail(unsupportedProviderOperation("pullArtifact")),
  removeArtifact: () => Effect.fail(unsupportedProviderOperation("removeArtifact")),
  apply: () => Effect.fail(unsupportedProviderOperation("apply")),
  start: () => Effect.fail(unsupportedProviderOperation("start")),
  stop: () => Effect.fail(unsupportedProviderOperation("stop")),
  restart: () => Effect.fail(unsupportedProviderOperation("restart")),
  waitForExit: () => Effect.fail(unsupportedProviderOperation("waitForExit")),
  destroy: () => Effect.fail(unsupportedProviderOperation("destroy")),
  removeObservedService: () => Effect.fail(unsupportedProviderOperation("removeObservedService")),
  readAppEnvironment: () => Effect.fail(unsupportedProviderOperation("readAppEnvironment")),
  exec: () => Effect.fail(unsupportedProviderOperation("exec")),
  execStream: () => Stream.fail(unsupportedProviderOperation("execStream")),
  run: () => Effect.fail(unsupportedProviderOperation("run")),
  runStream: () => Stream.fail(unsupportedProviderOperation("runStream")),
  logs: () => Stream.fail(unsupportedProviderOperation("logs")),
  inspect: () => Effect.fail(unsupportedProviderOperation("inspect")),
  list: () => Effect.fail(unsupportedProviderOperation("list")),
  snapshotVolume: () => Effect.fail(unsupportedProviderOperation("snapshotVolume")),
  removeVolumeSnapshot: () => Effect.fail(unsupportedProviderOperation("removeVolumeSnapshot")),
  restoreVolume: () => Effect.fail(unsupportedProviderOperation("restoreVolume")),
  locateVolume: () => Effect.fail(unsupportedProviderOperation("locateVolume")),
  listVolumes: () => Effect.fail(unsupportedProviderOperation("listVolumes")),
  removeVolume: () => Effect.fail(unsupportedProviderOperation("removeVolume")),
  copyToService: () => Effect.fail(unsupportedProviderOperation("copyToService")),
  copyFromService: () => Stream.fail(unsupportedProviderOperation("copyFromService")),
  exportArtifact: () => Stream.fail(unsupportedProviderOperation("exportArtifact")),
  importArtifact: () => Effect.fail(unsupportedProviderOperation("importArtifact")),
});

export const makeLibraryRenderer = (id: LibraryRendererMode): Context.Service.Shape<typeof Renderer> =>
  Renderer.of({
    id,
    capabilities: {
      color: false,
      interactive: false,
      animation: false,
      notifications: false,
    },
    message: {
      info: () => Effect.void,
      warn: () => Effect.void,
      error: () => Effect.void,
    },
    output: {
      stdout: () => Effect.void,
      stderr: () => Effect.void,
    },
  });
