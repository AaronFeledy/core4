/**
 * Runtime composition and `makeLandoRuntime` factory.
 *
 * The composed `LandoRuntimeLive` layer is built once at the host boundary
 * and then provided to the program. Intermediate layer composition stays out
 * of core except in tests.
 *
 * Factory behavior:
 * - Returns one `Layer` that satisfies the default service tags.
 * - Validates options with Effect Schema and can fail with
 *   `LandoRuntimeBootstrapError`.
 * - Is safe to call multiple times in one process; each call gets isolated
 *   caches, plugin registry, and event bus state.
 * - Does not mutate process-global state unless `installSignalHandlers: true`.
 * - Runs the requested bootstrap sequence.
 * - Keeps resource ownership in the layer's outer scope.
 */
import { type Context, Effect, Either, Layer, Schema, Stream } from "effect";

import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { AbsolutePath, ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type CacheService,
  type CommandRegistry,
  type ConfigService,
  type EventService,
  type FileSystem,
  type GlobalAppService,
  type LandofileService,
  type Logger,
  type PluginRegistry,
  RuntimeProvider,
  type RuntimeProviderRegistry,
  type ScratchAppService,
  type ToolingEngine,
} from "@lando/sdk/services";

import { engine as FileSyncEngineLive } from "@lando/file-sync-mutagen";

import { CacheServiceLive } from "../cache/service.ts";
import { GlobalAppServiceLive } from "../global-app/service.ts";
import { LandofileServiceLive } from "../landofile/service.ts";
import { LoggerLive, type LoggerMode } from "../logging/service.ts";
import { PluginRegistryLive } from "../plugins/registry.ts";
import { RuntimeProviderRegistryLive } from "../providers/registry.ts";
import { ScratchAppServiceLive } from "../scratch-app/service.ts";
import { CommandRegistryLive } from "../services/command-registry.ts";
import { ConfigServiceLive } from "../services/config.ts";
import { EventServiceLive } from "../services/event-service.ts";
import { FileSystemLive } from "../services/file-system.ts";
import { AppPlannerLive } from "../services/planner.ts";
import { ProviderExecToolingEngineLive } from "../services/tooling-engine.ts";
import { BootstrapLevel } from "./bootstrap.ts";

// Differences from CLI defaults:
// - logger: "silent" in library mode (CLI: "pretty"/"json")
// - renderer: "json" in library mode (CLI: "lando")
// - plugin discovery: host-provided only (CLI: bundled+system+user+app)
// - telemetry: off (CLI: per global config)
// - signal handlers: not installed (CLI: installed)
// - bootstrap: required option (CLI: declared per command)

/** Plugin discovery toggles for embedding hosts. */
export const EmbeddingDiscoveryPolicy = Schema.Struct({
  bundled: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Boolean),
  user: Schema.optional(Schema.Boolean),
  app: Schema.optional(Schema.Boolean),
});

/**
 * Plugin policy for embedding hosts.
 *
 * The runtime treats `layers`, `manifests`, and discovered plugins as one
 * contribution graph subject to selection precedence and conflict rules.
 */
export const EmbeddingPluginPolicy = Schema.Struct({
  /** Direct Effect Layers. Each must satisfy one or more pluggable abstractions. */
  layers: Schema.optional(Schema.Array(Schema.Unknown)),
  /** Pre-resolved plugin manifests and entry modules. */
  manifests: Schema.optional(Schema.Array(Schema.Unknown)),
  /** Opt into the standard discovery chain. Defaults are `false` in library mode and `true` in CLI mode. */
  discovery: Schema.optional(EmbeddingDiscoveryPolicy),
  /** Force-disable plugins by name regardless of source. */
  disable: Schema.optional(Schema.Array(Schema.String)),
});

const GlobalConfigOverrides = Schema.Struct({
  userDataRoot: Schema.optional(AbsolutePath),
  userConfRoot: Schema.optional(AbsolutePath),
  defaultProviderId: Schema.optional(Schema.Union(ProviderId, Schema.Null)),
  telemetry: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
    }),
  ),
});

/** Runtime options bag. */
export const LandoRuntimeOptions = Schema.Struct({
  /** Bootstrap depth. Default `"app"` for embedding. */
  bootstrap: Schema.optional(BootstrapLevel),
  /** Working directory for Landofile discovery. Required if bootstrap >= "app". */
  cwd: Schema.optional(Schema.String),
  /** Plugin source policy. Default: host-provided only. */
  plugins: Schema.optional(EmbeddingPluginPolicy),
  /** Inline overrides applied after global config + env, before Landofile. */
  config: Schema.optional(GlobalConfigOverrides),
  /** Renderer/logger preset shortcuts. */
  logger: Schema.optional(Schema.String),
  renderer: Schema.optional(Schema.String),
  /** Telemetry: opt-in only in library mode. */
  telemetry: Schema.optional(Schema.Boolean),
  /** Cache root override. Defaults to `<userCacheRoot>/lando`. */
  cacheRoot: Schema.optional(Schema.String),
  /** Signal handling: the host owns SIGINT/SIGTERM by default. Set true to install the same handler the CLI uses. */
  installSignalHandlers: Schema.optional(Schema.Boolean),
});
export type LandoRuntimeOptions = typeof LandoRuntimeOptions.Type;

type MinimalRuntimeServices = Logger | ConfigService | FileSystem | CacheService;
type ToolingRuntimeServices = MinimalRuntimeServices | LandofileService | CommandRegistry;
type ProviderRuntimeServices =
  | MinimalRuntimeServices
  | PluginRegistry
  | RuntimeProvider
  | RuntimeProviderRegistry
  | GlobalAppService;
type GlobalRuntimeServices = ProviderRuntimeServices | AppPlanner;
type ScratchRuntimeServices = ProviderRuntimeServices | LandofileService | AppPlanner | ScratchAppService;
export type AppRuntimeServices =
  | ProviderRuntimeServices
  | LandofileService
  | CommandRegistry
  | AppPlanner
  | EventService
  | ToolingEngine;
type RuntimeLayer =
  | Layer.Layer<never>
  | Layer.Layer<MinimalRuntimeServices>
  | Layer.Layer<MinimalRuntimeServices, LandoRuntimeBootstrapError>
  | Layer.Layer<ToolingRuntimeServices>
  | Layer.Layer<ToolingRuntimeServices, LandoRuntimeBootstrapError>
  | Layer.Layer<ProviderRuntimeServices>
  | Layer.Layer<ProviderRuntimeServices, LandoRuntimeBootstrapError>
  | Layer.Layer<GlobalRuntimeServices>
  | Layer.Layer<GlobalRuntimeServices, LandoRuntimeBootstrapError>
  | Layer.Layer<ScratchRuntimeServices>
  | Layer.Layer<ScratchRuntimeServices, LandoRuntimeBootstrapError>
  | Layer.Layer<AppRuntimeServices>
  | Layer.Layer<AppRuntimeServices, LandoRuntimeBootstrapError>
  | Layer.Layer<unknown, LandoRuntimeBootstrapError>;

const providerCapabilities = Schema.decodeUnknownSync(ProviderCapabilities)({
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: false,
  serviceExec: false,
  serviceLogs: false,
  serviceHealth: "none",
  hostReachability: "none",
  sharedCrossAppNetwork: false,
  persistentStorage: false,
  bindMounts: false,
  bindMountPerformance: "none",
  copyMounts: false,
  hostPortPublish: "none",
  routeProvider: false,
  tlsCertificates: "none",
  rootless: true,
  privilegedServices: false,
  composeSpec: "none",
  providerExtensions: [],
});

const runtimeProviderService: Context.Tag.Service<typeof RuntimeProvider> = {
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
  logs: () => Stream.empty,
  inspect: () => Effect.die("runtime provider stub cannot inspect services"),
  list: () => Effect.succeed([]),
};

const collectEmbeddingPluginLayers = (
  options: LandoRuntimeOptions,
): Either.Either<ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>, LandoRuntimeBootstrapError> => {
  const entries = options.plugins?.layers ?? [];
  const layers: Layer.Layer<unknown, unknown, unknown>[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!Layer.isLayer(entry)) {
      return Either.left(
        bootstrapError(
          `Invalid Lando runtime options: plugins.layers[${index}] is not an Effect Layer.`,
          entry,
        ),
      );
    }
    layers.push(entry);
  }
  return Either.right(layers);
};

const makeMinimalRuntimeLive = (loggerMode: LoggerMode) =>
  Layer.mergeAll(LoggerLive({ mode: loggerMode }), ConfigServiceLive, CacheServiceLive, FileSystemLive);

const makeProviderRuntimeLive = (loggerMode: LoggerMode) => {
  const minimalRuntimeLive = makeMinimalRuntimeLive(loggerMode);
  const providerRegistryLive = RuntimeProviderRegistryLive.pipe(
    Layer.provide(Layer.mergeAll(minimalRuntimeLive, PluginRegistryLive, EventServiceLive)),
  );

  return Layer.mergeAll(
    minimalRuntimeLive,
    EventServiceLive,
    PluginRegistryLive,
    Layer.succeed(RuntimeProvider, runtimeProviderService),
    providerRegistryLive,
    GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
  );
};

const makeToolingRuntimeLive = (loggerMode: LoggerMode) =>
  Layer.mergeAll(
    makeMinimalRuntimeLive(loggerMode),
    LandofileServiceLive,
    CommandRegistryLive.pipe(Layer.provide(LandofileServiceLive)),
  );

const makeGlobalRuntimeLive = (loggerMode: LoggerMode) =>
  Layer.mergeAll(
    makeProviderRuntimeLive(loggerMode),
    AppPlannerLive.pipe(
      Layer.provide(Layer.mergeAll(PluginRegistryLive, CacheServiceLive, ConfigServiceLive)),
    ),
  );

const makeScratchRuntimeLive = (loggerMode: LoggerMode) => {
  const providerBase = makeProviderRuntimeLive(loggerMode);
  const plannerLive = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(PluginRegistryLive, CacheServiceLive, ConfigServiceLive)),
  );
  const scratchDeps = Layer.mergeAll(providerBase, LandofileServiceLive, plannerLive);
  return Layer.mergeAll(
    providerBase,
    LandofileServiceLive,
    plannerLive,
    ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)),
  );
};

const makeAppRuntimeLive = (loggerMode: LoggerMode) =>
  Layer.mergeAll(
    makeProviderRuntimeLive(loggerMode),
    LandofileServiceLive,
    CommandRegistryLive.pipe(Layer.provide(LandofileServiceLive)),
    AppPlannerLive.pipe(Layer.provide(Layer.mergeAll(PluginRegistryLive, CacheServiceLive))),
    ProviderExecToolingEngineLive,
    FileSyncEngineLive,
  );

const runtimeLayerFor = (bootstrap: BootstrapLevel, loggerMode: LoggerMode): RuntimeLayer => {
  switch (bootstrap) {
    case "none":
      return Layer.empty;
    case "minimal":
    case "plugins":
    case "commands":
      return makeMinimalRuntimeLive(loggerMode);
    case "tooling":
      return makeToolingRuntimeLive(loggerMode);
    case "provider":
      return makeProviderRuntimeLive(loggerMode);
    case "global":
      return makeGlobalRuntimeLive(loggerMode);
    case "scratch":
      return makeScratchRuntimeLive(loggerMode);
    case "app":
      return makeAppRuntimeLive(loggerMode);
  }
};

const bootstrapError = (message: string, cause: unknown): LandoRuntimeBootstrapError =>
  new LandoRuntimeBootstrapError({
    message,
    stage: "minimal",
    cause,
  });

/**
 * `makeLandoRuntime`.
 *
 * Builds the runtime layer for the requested bootstrap depth. This factory
 * owns composition and option validation only.
 */
export function makeLandoRuntime(options: { readonly bootstrap: "minimal" }): Layer.Layer<
  MinimalRuntimeServices,
  LandoRuntimeBootstrapError
>;
export function makeLandoRuntime(options: { readonly bootstrap: "provider" }): Layer.Layer<
  ProviderRuntimeServices,
  LandoRuntimeBootstrapError
>;
export function makeLandoRuntime(options: { readonly bootstrap: "global" }): Layer.Layer<
  GlobalRuntimeServices,
  LandoRuntimeBootstrapError
>;
export function makeLandoRuntime(options: { readonly bootstrap: "scratch" }): Layer.Layer<
  ScratchRuntimeServices,
  LandoRuntimeBootstrapError
>;
export function makeLandoRuntime(options: { readonly bootstrap: "app" }): Layer.Layer<
  AppRuntimeServices,
  LandoRuntimeBootstrapError
>;
export function makeLandoRuntime(options: unknown): RuntimeLayer;
export function makeLandoRuntime(options: unknown): RuntimeLayer {
  const decoded = Schema.decodeUnknownEither(LandoRuntimeOptions)(options);

  if (Either.isLeft(decoded)) {
    return Layer.fail(bootstrapError("Invalid Lando runtime options.", decoded.left));
  }

  const baseLayer = runtimeLayerFor(
    decoded.right.bootstrap ?? "app",
    decoded.right.logger === "pretty" ? "pretty" : "silent",
  );
  const hostLayersResult = collectEmbeddingPluginLayers(decoded.right);

  if (Either.isLeft(hostLayersResult)) {
    return Layer.fail(hostLayersResult.left);
  }

  const hostLayers = hostLayersResult.right;
  return hostLayers.length === 0 ? baseLayer : (Layer.mergeAll(baseLayer, ...hostLayers) as RuntimeLayer);
}
