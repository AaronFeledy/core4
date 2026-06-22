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
import { Effect, Either, Layer, Schema } from "effect";

import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { AbsolutePath, EmbeddingPluginPolicy, ProviderId } from "@lando/sdk/schema";
import type {
  AppPlanner,
  CacheService,
  CommandRegistry,
  ConfigService,
  Downloader,
  EventService,
  FileSystem,
  GlobalAppService,
  LandofileService,
  Logger,
  ManagedFileService,
  PluginRegistry,
  PluginTrustStore,
  PrivilegeService,
  ProcessRunner,
  Renderer,
  RuntimeProvider,
  RuntimeProviderRegistry,
  ScratchAppService,
  Telemetry,
  ToolingEngine,
} from "@lando/sdk/services";

import type { LoggerMode } from "../logging/service.ts";
import type { BootstrapLayerPluginDiscovery } from "./bootstrap-layer-support.ts";
import { BootstrapLevel } from "./bootstrap.ts";
import { RuntimeCwd } from "./cwd.ts";
import { makeGeneratedBootstrapLayer, mergeRuntimeWithHostLayers } from "./generated/layers/index.ts";
import { installSignalHandlers } from "./interrupt.ts";

// Differences from CLI defaults:
// - logger: "silent" in library mode (CLI: "pretty"/"json")
// - renderer: "json" in library mode (CLI: "lando")
// - plugin discovery: host-provided only (CLI: bundled+system+user+app)
// - telemetry: off (CLI: per global config)
// - signal handlers: not installed (CLI: installed)
// - bootstrap: required option (CLI: declared per command)

const RuntimePluginDiscoveryOptions = Schema.Struct({
  bundled: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Boolean),
  user: Schema.optional(Schema.Boolean),
  app: Schema.optional(Schema.Boolean),
});

const RuntimePluginOptions = Schema.Struct({
  policy: Schema.optional(EmbeddingPluginPolicy),
  layers: Schema.optional(Schema.Array(Schema.Unknown)),
  manifests: Schema.optional(Schema.Array(Schema.Unknown)),
  discovery: Schema.optional(RuntimePluginDiscoveryOptions),
  externalImports: Schema.optional(Schema.Boolean),
  disable: Schema.optional(Schema.Array(Schema.String)),
});
type RuntimePluginOptions = typeof RuntimePluginOptions.Type;

const GlobalConfigOverrides = Schema.Struct({
  userDataRoot: Schema.optional(AbsolutePath),
  userConfRoot: Schema.optional(AbsolutePath),
  defaultProviderId: Schema.optional(Schema.Union(ProviderId, Schema.Null)),
  telemetry: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
    }),
  ),
  renderer: Schema.optional(Schema.String),
});

const LIBRARY_RENDERER_MODES = ["json", "plain", "verbose", "lando"] as const;
type LibraryRendererMode = (typeof LIBRARY_RENDERER_MODES)[number];

const isLibraryRendererMode = (value: string): value is LibraryRendererMode =>
  (LIBRARY_RENDERER_MODES as ReadonlyArray<string>).includes(value);

const normalizeLibraryRendererMode = (value: string | undefined): LibraryRendererMode =>
  value === undefined ? "json" : isLibraryRendererMode(value) ? value : "json";

/** Runtime options bag. */
export const LandoRuntimeOptions = Schema.Struct({
  /** Bootstrap depth. Default `"app"` for embedding. */
  bootstrap: Schema.optional(BootstrapLevel),
  /** Working directory for Landofile discovery. Required if bootstrap >= "app". */
  cwd: Schema.optional(Schema.String),
  /** Plugin source policy. Default: host-provided only. */
  plugins: Schema.optional(RuntimePluginOptions),
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

type MinimalRuntimeServices =
  | Logger
  | Renderer
  | Telemetry
  | ConfigService
  | FileSystem
  | CacheService
  | ManagedFileService
  | PluginTrustStore
  | PrivilegeService
  | ProcessRunner
  | Downloader;
type PluginRuntimeServices = MinimalRuntimeServices | PluginRegistry;
type ToolingRuntimeServices = MinimalRuntimeServices | PluginRegistry | LandofileService | CommandRegistry;
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
  | ToolingEngine
  | RuntimeCwd;
type RuntimeLayer =
  | Layer.Layer<never>
  | Layer.Layer<MinimalRuntimeServices>
  | Layer.Layer<MinimalRuntimeServices, LandoRuntimeBootstrapError>
  | Layer.Layer<PluginRuntimeServices>
  | Layer.Layer<PluginRuntimeServices, LandoRuntimeBootstrapError>
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

const collectEmbeddingPluginLayers = (
  entries: ReadonlyArray<unknown>,
): Either.Either<ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>, LandoRuntimeBootstrapError> => {
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

interface NormalizedPluginPolicy {
  readonly layers: ReadonlyArray<unknown>;
  readonly discovery: BootstrapLayerPluginDiscovery;
}

const normalizePluginPolicy = (plugins: RuntimePluginOptions | undefined): NormalizedPluginPolicy => {
  const rawPolicy = plugins?.policy;
  const policy =
    rawPolicy === undefined ? undefined : typeof rawPolicy === "string" ? { mode: rawPolicy } : rawPolicy;
  const mode =
    policy?.mode ??
    (policy?.discovery === undefined && plugins?.discovery === undefined ? "explicit" : "discovery");
  const discovery = policy?.discovery ?? plugins?.discovery;
  const disables = [...(plugins?.disable ?? []), ...(policy?.disable ?? [])];

  return {
    layers: policy?.layers ?? plugins?.layers ?? [],
    discovery: {
      bundled: mode === "bundled-only" || mode === "discovery" ? (discovery?.bundled ?? true) : false,
      user: mode === "discovery" ? (discovery?.user ?? true) : false,
      app: mode === "discovery" ? (discovery?.app ?? true) : false,
      disable: disables,
    },
  };
};

const runtimeLayerFor = (
  bootstrap: BootstrapLevel,
  loggerMode: LoggerMode,
  rendererMode: LibraryRendererMode,
  telemetryEnabled: boolean,
  pluginPolicy: NormalizedPluginPolicy,
): RuntimeLayer =>
  makeGeneratedBootstrapLayer(bootstrap, {
    loggerMode,
    rendererMode,
    telemetryEnabled,
    pluginDiscovery: pluginPolicy.discovery,
  }) as RuntimeLayer;

const signalHandlersLayer = Layer.scopedDiscard(
  Effect.withFiberRuntime((fiber) => installSignalHandlers({ fiber })),
);

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
type LandoRuntimeOptionsFor<TBootstrap extends BootstrapLevel> = LandoRuntimeOptions & {
  readonly bootstrap: TBootstrap;
};

export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"minimal">,
): Layer.Layer<MinimalRuntimeServices, LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"plugins">,
): Layer.Layer<PluginRuntimeServices, LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"commands">,
): Layer.Layer<MinimalRuntimeServices, LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"tooling">,
): Layer.Layer<ToolingRuntimeServices, LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"provider">,
): Layer.Layer<ProviderRuntimeServices, LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"global">,
): Layer.Layer<GlobalRuntimeServices, LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"scratch">,
): Layer.Layer<ScratchRuntimeServices, LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"app">,
): Layer.Layer<AppRuntimeServices, LandoRuntimeBootstrapError>;
export function makeLandoRuntime(options: unknown): RuntimeLayer;
export function makeLandoRuntime(options: unknown): RuntimeLayer {
  const decoded = Schema.decodeUnknownEither(LandoRuntimeOptions)(options);

  if (Either.isLeft(decoded)) {
    return Layer.fail(bootstrapError("Invalid Lando runtime options.", decoded.left));
  }

  const pluginPolicy = normalizePluginPolicy(decoded.right.plugins);
  const capturedCwd = decoded.right.cwd ?? process.cwd();
  const baseLayer = runtimeLayerFor(
    decoded.right.bootstrap ?? "app",
    decoded.right.logger === "pretty" ? "pretty" : "silent",
    normalizeLibraryRendererMode(decoded.right.renderer ?? decoded.right.config?.renderer),
    decoded.right.telemetry ?? decoded.right.config?.telemetry?.enabled ?? false,
    pluginPolicy,
  );
  const hostLayersResult = collectEmbeddingPluginLayers(pluginPolicy.layers);

  if (Either.isLeft(hostLayersResult)) {
    return Layer.fail(hostLayersResult.left);
  }

  const hostLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>> =
    decoded.right.installSignalHandlers === true
      ? [
          Layer.succeed(RuntimeCwd, capturedCwd) as unknown as Layer.Layer<unknown, unknown, unknown>,
          ...hostLayersResult.right,
          signalHandlersLayer as unknown as Layer.Layer<unknown, unknown, unknown>,
        ]
      : [
          Layer.succeed(RuntimeCwd, capturedCwd) as unknown as Layer.Layer<unknown, unknown, unknown>,
          ...hostLayersResult.right,
        ];
  return mergeRuntimeWithHostLayers(
    baseLayer as unknown as Layer.Layer<unknown, unknown, unknown>,
    hostLayers,
  ) as RuntimeLayer;
}
