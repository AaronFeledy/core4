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
import { type Layer, Schema } from "effect";

import { GlobalConfig } from "@lando/sdk/schema";

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
  config: Schema.optional(Schema.partial(GlobalConfig)),
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

/**
 * `makeLandoRuntime`.
 *
 * TODO: construct the composed `LandoRuntimeLive` Layer at the
 * requested bootstrap level. The composition is roughly:
 *
 *   Layer.mergeAll(
 *     ConfigServiceLive,
 *     FileSystemBunLive,
 *     ProcessRunnerBunLive,
 *     LoggerLive,
 *     EventServiceLive,
 *     CacheServiceLive,
 *     PluginRegistryLive,
 *     CommandRegistryLive,
 *     RuntimeProviderRegistryLive,
 *     AppPlannerLive,
 *     RendererLive,
 *     // ... plus host-contributed Layers
 *   )
 *
 * Filtered by `bootstrap` level and overridden by `options.plugins.layers`.
 */
export const makeLandoRuntime = (_options: LandoRuntimeOptions): Layer.Layer<never, never, never> => {
  throw new Error("makeLandoRuntime: not yet implemented");
};
