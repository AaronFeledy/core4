/**
 * `makeLandoRuntime` option schema and normalization.
 *
 * Owns the embedding-host option contract (`LandoRuntimeOptions`) and the pure
 * resolution of those options into the inputs the runtime-layer composition
 * consumes: plugin policy → discovery flags, config overrides → root overrides,
 * renderer preset → library renderer mode, and validation of host-supplied
 * plugin layers. No layer composition happens here.
 */
import { Either, Layer, Schema } from "effect";

import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  EmbeddingPluginPolicy,
  LOG_LEVELS,
  type LogLevel,
  ProviderId,
  ResolvedPluginInput,
  type ResolvedPluginInput as ResolvedPluginInputType,
} from "@lando/sdk/schema";
import type { RootOverrides } from "@lando/sdk/services";

import type { LoggerMode } from "../logging/service.ts";
import type { BootstrapLayerPluginDiscovery } from "./bootstrap-layer-support.ts";
import { BootstrapLevel } from "./bootstrap.ts";

// Differences from CLI defaults:
// - logger: "silent" in library mode (CLI: "none" unless --log-level)
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
  manifests: Schema.optional(Schema.Array(ResolvedPluginInput)),
  discovery: Schema.optional(RuntimePluginDiscoveryOptions),
  externalImports: Schema.optional(Schema.Boolean),
  disable: Schema.optional(Schema.Array(Schema.String)),
});
type RuntimePluginOptions = typeof RuntimePluginOptions.Type;

const GlobalConfigOverrides = Schema.Struct({
  userDataRoot: Schema.optional(AbsolutePath),
  userConfRoot: Schema.optional(AbsolutePath),
  userCacheRoot: Schema.optional(AbsolutePath),
  systemPluginRoot: Schema.optional(AbsolutePath),
  defaultProviderId: Schema.optional(Schema.Union(ProviderId, Schema.Null)),
  telemetry: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
    }),
  ),
  renderer: Schema.optional(Schema.String),
  logLevel: Schema.optional(Schema.String),
});

const LIBRARY_RENDERER_MODES = ["json", "plain", "verbose", "lando"] as const;
export type LibraryRendererMode = (typeof LIBRARY_RENDERER_MODES)[number];

const isLibraryRendererMode = (value: string): value is LibraryRendererMode =>
  (LIBRARY_RENDERER_MODES as ReadonlyArray<string>).includes(value);

export const normalizeLibraryRendererMode = (value: string | undefined): LibraryRendererMode =>
  value === undefined ? "json" : isLibraryRendererMode(value) ? value : "json";

const isLogLevel = (value: string): value is LogLevel =>
  (LOG_LEVELS as ReadonlyArray<string>).includes(value);

export interface RuntimeLogging {
  readonly loggerMode: LoggerMode;
  readonly logLevel: LogLevel | undefined;
  readonly structured: boolean;
}

/**
 * Resolve Effect logger mode + diagnostic level for bootstrap.
 *
 * `none` (or omitted) stays silent. A non-`none` level uses pretty mode so
 * `LoggerLive` can install the stderr pretty/structured logger. `logger:
 * "pretty"` remains an independent embedder override and does not flip the
 * library renderer. JSON renderer + a non-`none` level forces structured
 * stderr so machine output is not mixed with pretty prose.
 */
export const resolveRuntimeLogging = (
  options: Pick<LandoRuntimeOptions, "logger" | "logLevel" | "config" | "renderer">,
): RuntimeLogging => {
  const raw = options.logLevel ?? options.config?.logLevel;
  const logLevel = raw === undefined || !isLogLevel(raw) ? undefined : raw;
  const rendererMode = normalizeLibraryRendererMode(options.renderer ?? options.config?.renderer);
  const structured = rendererMode === "json" && logLevel !== undefined && logLevel !== "none";
  if (options.logger === "pretty" && (logLevel === undefined || logLevel === "none")) {
    return { loggerMode: "pretty", logLevel: undefined, structured: false };
  }
  if (logLevel === undefined || logLevel === "none") {
    return { loggerMode: "silent", logLevel, structured: false };
  }
  return { loggerMode: "pretty", logLevel, structured };
};

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
  logLevel: Schema.optional(Schema.String),
  /** Telemetry: opt-in only in library mode. */
  telemetry: Schema.optional(Schema.Boolean),
  /** Default prompt interactivity. Library mode defaults to `non-interactive`. */
  interaction: Schema.optional(Schema.Literal("auto", "interactive", "non-interactive")),
  /** Cache root override. Defaults to `<userCacheRoot>/lando`. */
  cacheRoot: Schema.optional(Schema.String),
  /** Signal handling: the host owns SIGINT/SIGTERM by default. Set true to install the same handler the CLI uses. */
  installSignalHandlers: Schema.optional(Schema.Boolean),
});
export type LandoRuntimeOptions = typeof LandoRuntimeOptions.Type;

export const bootstrapError = (message: string, cause: unknown): LandoRuntimeBootstrapError =>
  new LandoRuntimeBootstrapError({
    message,
    stage: "minimal",
    cause,
  });

export const collectEmbeddingPluginLayers = (
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

export interface NormalizedPluginPolicy {
  readonly layers: ReadonlyArray<unknown>;
  readonly manifests: ReadonlyArray<ResolvedPluginInputType>;
  readonly discovery: BootstrapLayerPluginDiscovery;
  readonly externalImports: boolean;
}

export const normalizePluginPolicy = (plugins: RuntimePluginOptions | undefined): NormalizedPluginPolicy => {
  const rawPolicy = plugins?.policy;
  const policy =
    rawPolicy === undefined ? undefined : typeof rawPolicy === "string" ? { mode: rawPolicy } : rawPolicy;
  const mode =
    policy?.mode ??
    (policy?.discovery === undefined && plugins?.discovery === undefined ? "explicit" : "discovery");
  const discovery = policy?.discovery ?? plugins?.discovery;
  const disables = [...(plugins?.disable ?? []), ...(policy?.disable ?? [])];
  const system = mode === "discovery" ? (discovery?.system ?? true) : false;
  const user = mode === "discovery" ? (discovery?.user ?? true) : false;
  const app = mode === "discovery" ? (discovery?.app ?? true) : false;
  const externalImports = plugins?.externalImports ?? policy?.externalImports ?? (system || user || app);

  return {
    layers: policy?.layers ?? plugins?.layers ?? [],
    manifests: [...(plugins?.manifests ?? []), ...(policy?.manifests ?? [])],
    discovery: {
      bundled: mode === "bundled-only" || mode === "discovery" ? (discovery?.bundled ?? true) : false,
      system,
      user,
      app,
      disable: disables,
    },
    externalImports,
  };
};

type GlobalConfigOverrides = typeof GlobalConfigOverrides.Type;

export const rootOverridesFromConfig = (config: GlobalConfigOverrides | undefined): RootOverrides => {
  if (config === undefined) return {};
  return {
    ...(config.userConfRoot === undefined ? {} : { userConfRoot: config.userConfRoot }),
    ...(config.userCacheRoot === undefined ? {} : { userCacheRoot: config.userCacheRoot }),
    ...(config.userDataRoot === undefined ? {} : { userDataRoot: config.userDataRoot }),
    ...(config.systemPluginRoot === undefined ? {} : { systemPluginRoot: config.systemPluginRoot }),
  };
};
