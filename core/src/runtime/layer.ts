/**
 * `LandoRuntimeLive` composition + `makeLandoRuntime` factory.
 *
 * The composed `LandoRuntimeLive` Layer is built once at the imperative
 * shell — the OCLIF command's `run()` method (CLI) or the embedding host's
 * `Effect.provide(runtime)` call (library) — and provided to the program.
 * Intermediate layer composition is forbidden in core except for testing.
 *
 * **Factory contract**:
 * - Returns a single `Layer` that satisfies every default service tag.
 * - Validates options with Effect Schema; failure channel includes
 *   `LandoRuntimeBootstrapError`.
 * - Safe to call multiple times in one process; each call yields an
 *   independent runtime with its own caches, plugin registry, event bus.
 * - Does not mutate process-global state unless `installSignalHandlers: true`.
 * - Runs the same bootstrap sequence up to the requested level.
 * - Layer's outer scope owns all resource handles.
 */
import { type Context, Effect, Either, Layer, Schema, Stream } from "effect";

import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { AbsolutePath, ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type CommandRegistry,
  type ConfigService,
  type EventService,
  FileSystem,
  type LandofileService,
  type Logger,
  RuntimeProvider,
  type RuntimeProviderRegistry,
  type ToolingEngine,
} from "@lando/sdk/services";

import { LandofileServiceLive } from "../landofile/service.ts";
import { LoggerLive, type LoggerMode } from "../logging/service.ts";
import { PluginRegistryLive } from "../plugins/registry.ts";
import { RuntimeProviderRegistryLive } from "../providers/registry.ts";
import { CommandRegistryLive } from "../services/command-registry.ts";
import { ConfigServiceLive } from "../services/config.ts";
import { EventServiceLive } from "../services/event-service.ts";
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

/**
 * Plugin discovery toggles for embedding hosts.
 */
export const EmbeddingDiscoveryPolicy = Schema.Struct({
  bundled: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Boolean),
  user: Schema.optional(Schema.Boolean),
  app: Schema.optional(Schema.Boolean),
});

/**
 * Plugin policy for embedding hosts.
 *
 * The runtime treats `layers`, `manifests`, and discovery-found plugins as
 * a single contribution graph subject to selection precedence and conflict
 * rules (`conflicts:`).
 */
export const EmbeddingPluginPolicy = Schema.Struct({
  /**
   * Direct Effect Layers. Most lightweight option. Each must be a
   * `Layer<unknown, unknown, never>` that satisfies one or more pluggable
   * abstractions.
   */
  layers: Schema.optional(Schema.Array(Schema.Unknown)),
  /**
   * Pre-resolved plugin manifests + entry modules. Goes through the full
   * `PluginRegistry` pipeline (validation, contribution graph, subscribers).
   */
  manifests: Schema.optional(Schema.Array(Schema.Unknown)),
  /**
   * Opt-in to the standard discovery chain. Defaults: all `false` in library
   * mode, all `true` in CLI mode.
   */
  discovery: Schema.optional(EmbeddingDiscoveryPolicy),
  /**
   * Force-disable plugins by name regardless of source.
   */
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

/**
 * `LandoRuntimeOptions` — options bag.
 */
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
  /**
   * Signal handling: the host owns SIGINT/SIGTERM by default. Set true to
   * install the same handler the CLI uses.
   */
  installSignalHandlers: Schema.optional(Schema.Boolean),
});
export type LandoRuntimeOptions = typeof LandoRuntimeOptions.Type;

type MinimalRuntimeServices = Logger | ConfigService | FileSystem;
type ToolingRuntimeServices = MinimalRuntimeServices | LandofileService | CommandRegistry;
type ProviderRuntimeServices = MinimalRuntimeServices | RuntimeProvider | RuntimeProviderRegistry;
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

const fileSystemService: Context.Tag.Service<typeof FileSystem> = {
  read: () => Stream.empty,
  readText: () => Effect.succeed(""),
  write: () => Effect.void,
  writeAtomic: () => Effect.void,
  exists: () => Effect.succeed(false),
  stat: () => Effect.succeed({ size: 0, mtimeMs: 0, isFile: false, isDirectory: false }),
  mkdir: () => Effect.void,
  remove: () => Effect.void,
  readDir: () => Effect.succeed([]),
  readFile: () => Effect.succeed(""),
  writeFile: () => Effect.void,
};

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

const makeMinimalRuntimeLive = (loggerMode: LoggerMode) =>
  Layer.mergeAll(
    LoggerLive({ mode: loggerMode }),
    ConfigServiceLive,
    Layer.succeed(FileSystem, fileSystemService),
  );

const makeProviderRuntimeLive = (loggerMode: LoggerMode) => {
  const minimalRuntimeLive = makeMinimalRuntimeLive(loggerMode);
  const providerRegistryLive = RuntimeProviderRegistryLive.pipe(
    Layer.provide(Layer.mergeAll(minimalRuntimeLive, PluginRegistryLive, EventServiceLive)),
  );

  return Layer.mergeAll(
    minimalRuntimeLive,
    EventServiceLive,
    Layer.succeed(RuntimeProvider, runtimeProviderService),
    providerRegistryLive,
  );
};

const makeToolingRuntimeLive = (loggerMode: LoggerMode) =>
  Layer.mergeAll(
    makeMinimalRuntimeLive(loggerMode),
    LandofileServiceLive,
    CommandRegistryLive.pipe(Layer.provide(LandofileServiceLive)),
  );

const makeAppRuntimeLive = (loggerMode: LoggerMode) =>
  Layer.mergeAll(
    makeProviderRuntimeLive(loggerMode),
    LandofileServiceLive,
    CommandRegistryLive.pipe(Layer.provide(LandofileServiceLive)),
    AppPlannerLive.pipe(Layer.provide(PluginRegistryLive)),
    ProviderExecToolingEngineLive,
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
    case "global":
    case "scratch":
      return makeProviderRuntimeLive(loggerMode);
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
 * Builds the runtime Layer for the requested bootstrap depth. Service
 * implementations are intentionally skeletal until the later foundation and
 * provider stories fill in their behavior; this factory owns only composition
 * and option validation.
 */
export function makeLandoRuntime(options: { readonly bootstrap: "minimal" }): Layer.Layer<
  MinimalRuntimeServices,
  LandoRuntimeBootstrapError
>;
export function makeLandoRuntime(options: { readonly bootstrap: "provider" }): Layer.Layer<
  ProviderRuntimeServices,
  LandoRuntimeBootstrapError
>;
export function makeLandoRuntime(options: { readonly bootstrap: "app" }): Layer.Layer<
  AppRuntimeServices,
  LandoRuntimeBootstrapError
>;
export function makeLandoRuntime(options: unknown): RuntimeLayer;
export function makeLandoRuntime(options: unknown): RuntimeLayer {
  if (process.env.LANDO_DEBUG_THROW_ON_RUNTIME === "1") {
    throw new Error("makeLandoRuntime debug hook was reached.");
  }

  const decoded = Schema.decodeUnknownEither(LandoRuntimeOptions)(options);

  if (Either.isLeft(decoded)) {
    return Layer.fail(bootstrapError("Invalid Lando runtime options.", decoded.left));
  }

  return runtimeLayerFor(
    decoded.right.bootstrap ?? "app",
    decoded.right.logger === "pretty" ? "pretty" : "silent",
  );
}
