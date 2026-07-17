import { type Context, Effect, Schema, Stream } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { ProviderCapabilities } from "@lando/sdk/schema";
import type { Renderer, RootOverrides, RuntimeProvider, Telemetry } from "@lando/sdk/services";

import type { LoggerMode } from "../logging/service.ts";

export type LibraryRendererMode = "json" | "plain" | "verbose" | "lando";

export interface BootstrapLayerPluginDiscovery {
  readonly bundled: boolean;
  readonly user: boolean;
  readonly app: boolean;
  readonly disable: ReadonlyArray<string>;
}

export interface BootstrapLayerInputs {
  readonly loggerMode: LoggerMode;
  readonly rendererMode: LibraryRendererMode;
  readonly telemetryEnabled: boolean;
  readonly pluginDiscovery: BootstrapLayerPluginDiscovery;
  readonly rootOverrides: RootOverrides;
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
  });

export const runtimeProviderService: Context.Tag.Service<typeof RuntimeProvider> = {
  id: "stub",
  displayName: "Stub Runtime Provider",
  version: "0.0.0",
  platform: "linux",
  capabilities: providerCapabilities,
  isAvailable: Effect.succeed(false),
  setup: () => Effect.void,
  getStatus: Effect.succeed({ running: false }),
  getVersions: Effect.succeed({ provider: "0.0.0" }),
  buildArtifact: () => Effect.die("runtime provider stub cannot build artifacts"),
  pullArtifact: () => Effect.die("runtime provider stub cannot pull artifacts"),
  removeArtifact: () => Effect.void,
  apply: () => Effect.succeed({ changed: false }),
  start: () => Effect.void,
  stop: () => Effect.void,
  restart: () => Effect.void,
  destroy: () => Effect.void,
  exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "runtime provider stub cannot exec" }),
  execStream: () => Stream.empty,
  run: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "runtime provider stub cannot run" }),
  runStream: () => Stream.fail(unsupportedProviderOperation("runStream")),
  logs: () => Stream.empty,
  inspect: () => Effect.die("runtime provider stub cannot inspect services"),
  list: () => Effect.succeed([]),
  snapshotVolume: () => Effect.die("runtime provider stub cannot snapshot volumes"),
  restoreVolume: () => Effect.die("runtime provider stub cannot restore volumes"),
  listVolumes: () => Effect.die("runtime provider stub cannot list volumes"),
  removeVolume: () => Effect.die("runtime provider stub cannot remove volumes"),
  copyToService: () => Effect.die("runtime provider stub cannot copy to services"),
  copyFromService: () => Stream.fail(unsupportedProviderOperation("copyFromService")),
  exportArtifact: () => Stream.fail(unsupportedProviderOperation("exportArtifact")),
  importArtifact: () => Effect.die("runtime provider stub cannot import artifacts"),
};

export const makeLibraryRenderer = (id: LibraryRendererMode): Context.Tag.Service<typeof Renderer> => ({
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

export const makeLibraryTelemetry = (enabled: boolean): Context.Tag.Service<typeof Telemetry> => ({
  enabled,
  record: () => Effect.void,
});
