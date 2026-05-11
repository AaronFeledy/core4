/**
 * Public Effect Schemas — the canonical contract for every Lando data shape
 * that crosses a trust boundary (Landofile, plugin manifest, service config,
 * tooling config, route config, healthcheck config, event payloads, plan
 * shapes, etc.).
 *
 * Every external contract is an Effect Schema; Effect Schema is the only
 * schema library in core. Schemas are published from `@lando/sdk` and
 * re-exported by `@lando/core/schema`. JSON Schema is generated at build
 * time from these.
 *
 * Status: MVP — expanded for Phase 2 (covers AppPlan/ServicePlan/MountPlan/
 * RoutePlan/EndpointPlan/HealthcheckPlan, BuildPlan, full ProviderCapabilities,
 * MVP-subset Landofile + ServiceConfig). Several spec keys are deferred (see
 * §7.4 for the full Landofile, §6.2 for the full ServiceConfig — gated behind
 * `// SPEC: §X.Y deferred for MVP` comments).
 */
import { Schema } from "effect";

// =============================================================================
// Branded primitives
// =============================================================================

export const AppId = Schema.String.pipe(Schema.brand("AppId"));
export type AppId = typeof AppId.Type;

export const ServiceName = Schema.String.pipe(Schema.brand("ServiceName"));
export type ServiceName = typeof ServiceName.Type;

export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"));
export type ProviderId = typeof ProviderId.Type;

export const PluginName = Schema.String.pipe(Schema.brand("PluginName"));
export type PluginName = typeof PluginName.Type;

export const AbsolutePath = Schema.String.pipe(Schema.brand("AbsolutePath"));
export type AbsolutePath = typeof AbsolutePath.Type;

export const PortablePath = Schema.String.pipe(Schema.brand("PortablePath"));
export type PortablePath = typeof PortablePath.Type;

// =============================================================================
// Host platform
// =============================================================================

export const HostPlatform = Schema.Literal("darwin", "linux", "win32", "wsl");
export type HostPlatform = typeof HostPlatform.Type;

export const HostArchitecture = Schema.Literal("x64", "arm64");
export type HostArchitecture = typeof HostArchitecture.Type;

// =============================================================================
// Bootstrap level — declared by every command, ranked by depth.
// SPEC: roadmap §"SDK contracts shipped"; spec/13-bootstrap-and-runtime.md
// =============================================================================

export const BootstrapLevel = Schema.Literal(
  "none",
  "minimal",
  "plugins",
  "commands",
  "tooling",
  "provider",
  "global",
  "scratch",
  "app",
);
export type BootstrapLevel = typeof BootstrapLevel.Type;

export const BOOTSTRAP_RANK: Record<BootstrapLevel, number> = {
  none: 0,
  minimal: 1,
  plugins: 2,
  commands: 3,
  tooling: 4,
  provider: 5,
  global: 6,
  scratch: 7,
  app: 8,
};

// =============================================================================
// Plan building blocks (referenced by ServicePlan/AppPlan)
// =============================================================================

/**
 * Plan metadata — every plan node carries this for traceability.
 * SPEC: §5.5
 */
export const PlanMetadata = Schema.Struct({
  /** Resolution timestamp (UTC). */
  resolvedAt: Schema.DateTimeUtc,
  /** Source Landofile path (or virtual id for recipe-rendered apps). */
  source: Schema.String,
  /** Lando runtime/format major version this plan was rendered for. */
  runtime: Schema.Literal(4),
});
export type PlanMetadata = typeof PlanMetadata.Type;

/**
 * Provider extension config — non-portable, opt-in provider-specific config
 * preserved through planning. Keys are provider ids; values are arbitrary.
 * SPEC: §5.6
 */
export const ProviderExtensionConfig = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
export type ProviderExtensionConfig = typeof ProviderExtensionConfig.Type;

/**
 * `command` / `entrypoint` accept either a single string or an argv array.
 * SPEC: §6.2
 */
export const CommandSpec = Schema.Union(Schema.String, Schema.Array(Schema.String));
export type CommandSpec = typeof CommandSpec.Type;

/**
 * Reference to a pre-built artifact (image, template, etc.) the provider
 * should pull rather than build. SPEC: §6.3
 */
export const ArtifactRef = Schema.Struct({
  kind: Schema.Literal("ref"),
  /** Provider-specific identifier (image name, registry URL, OCI ref…). */
  ref: Schema.String,
  /** Optional digest for reproducibility. */
  digest: Schema.optional(Schema.String),
});
export type ArtifactRef = typeof ArtifactRef.Type;

/**
 * Build spec — the planner instructs the provider to build an artifact from
 * source. SPEC: §6.3 + §6.13
 */
export const ArtifactBuildSpec = Schema.Struct({
  kind: Schema.Literal("build"),
  /** Build context root (absolute, host path). */
  context: AbsolutePath,
  /** Optional dockerfile/spec path relative to `context`. */
  spec: Schema.optional(PortablePath),
  /** Build args (string-keyed; values may be expression-resolved upstream). */
  args: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** Target stage (multi-stage builds). */
  target: Schema.optional(Schema.String),
  /** Content hash for buildKey computation (§6.13.5). */
  contentHash: Schema.optional(Schema.String),
});
export type ArtifactBuildSpec = typeof ArtifactBuildSpec.Type;

/** Build script for `build.artifact:` and `build.app:` entries. SPEC: §6.13 */
export const BuildScript = Schema.Union(Schema.String, Schema.Array(Schema.String));
export type BuildScript = typeof BuildScript.Type;

/**
 * App mount — the special mount of the app source root into the service.
 * SPEC: §6.4
 */
export const AppMountPlan = Schema.Struct({
  /** Absolute host path of the app root. */
  source: AbsolutePath,
  /** Mount point inside the container. */
  target: PortablePath,
  /** Read-only? */
  readOnly: Schema.Boolean,
  /** Excludes (gitignore-flavoured patterns). */
  excludes: Schema.Array(Schema.String),
  /** Includes — entries matched here override `excludes`. */
  includes: Schema.Array(Schema.String),
  /**
   * `passthrough` — provider-native bind mount.
   * `accelerated` — routed through the active FileSyncEngine (§4.2, §10.6).
   */
  realization: Schema.Literal("passthrough", "accelerated"),
});
export type AppMountPlan = typeof AppMountPlan.Type;

/**
 * Generic mount plan — any non-app, non-storage mount.
 * SPEC: §6.4
 */
export const MountPlan = Schema.Struct({
  /** Mount type: `bind` (host path), `tmpfs`, or `volume` (named/anon). */
  type: Schema.Literal("bind", "tmpfs", "volume"),
  /** Host path (`bind`), volume name (`volume`), or undefined (`tmpfs`). */
  source: Schema.optional(Schema.String),
  /** Mount point inside the container. */
  target: PortablePath,
  /** Read-only? */
  readOnly: Schema.Boolean,
  /** Realization strategy (same semantics as AppMountPlan.realization). */
  realization: Schema.Literal("passthrough", "accelerated"),
});
export type MountPlan = typeof MountPlan.Type;

/**
 * Storage scope — drives auto-naming for named volumes.
 * SPEC: §6.5
 */
export const StorageScope = Schema.Literal("service", "app", "global");
export type StorageScope = typeof StorageScope.Type;

/**
 * Data store — a named, persistent volume the provider must create.
 * SPEC: §6.5
 */
export const DataStorePlan = Schema.Struct({
  /** Provider-visible volume name (already auto-scoped). */
  name: Schema.String,
  scope: StorageScope,
  /** Driver (provider-specific; `null` = default). */
  driver: Schema.optional(Schema.String),
  /** Optional driver opts. */
  driverOpts: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});
export type DataStorePlan = typeof DataStorePlan.Type;

/**
 * Mount of a `DataStorePlan` into a service. SPEC: §6.5
 */
export const DataStoreMountPlan = Schema.Struct({
  /** Name of the DataStorePlan being mounted. */
  store: Schema.String,
  /** Mount point inside the container. */
  target: PortablePath,
  /** Read-only? */
  readOnly: Schema.Boolean,
});
export type DataStoreMountPlan = typeof DataStoreMountPlan.Type;

/**
 * Endpoint — a service listener. SPEC: §6.6
 */
export const EndpointPlan = Schema.Struct({
  /** Port number inside the container (or `null` for unix sockets). */
  port: Schema.optional(Schema.Number),
  /** Protocol layer (`http`, `https`, `tcp`, `udp`, `unix`). */
  protocol: Schema.Literal("http", "https", "tcp", "udp", "unix"),
  /** Optional human-friendly name (`web`, `db`, `socket`…). */
  name: Schema.optional(Schema.String),
  /** Unix socket path (when protocol = `unix`). */
  socketPath: Schema.optional(PortablePath),
});
export type EndpointPlan = typeof EndpointPlan.Type;

/**
 * Route reference attached to a service — points at AppPlan.routes by index.
 * SPEC: §6.6
 */
export const RouteRef = Schema.Struct({
  index: Schema.Number,
});
export type RouteRef = typeof RouteRef.Type;

/**
 * Route plan — host-facing HTTP/TLS mapping.
 * SPEC: §6.6
 */
export const RoutePlan = Schema.Struct({
  /** Host header pattern (`*.lndo.site`, `app.example.test`, …). */
  hostname: Schema.String,
  /** TLS scheme (`http`, `https`, `both`). */
  scheme: Schema.Literal("http", "https", "both"),
  /** Service name this route targets. */
  service: ServiceName,
  /** Endpoint name or port to forward to. */
  endpoint: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  /** Optional path prefix (e.g., `/api`). */
  pathPrefix: Schema.optional(Schema.String),
});
export type RoutePlan = typeof RoutePlan.Type;

/**
 * Healthcheck — provider-realized health probe. SPEC: §6.7
 */
export const HealthcheckPlan = Schema.Struct({
  kind: Schema.Literal("command", "http", "tcp", "none"),
  /** Command to run inside the container (kind = `command`). */
  command: Schema.optional(CommandSpec),
  /** URL (kind = `http`). */
  url: Schema.optional(Schema.String),
  /** Port (kind = `tcp`). */
  port: Schema.optional(Schema.Number),
  /** Interval, seconds. */
  intervalSeconds: Schema.Number,
  /** Per-attempt timeout, seconds. */
  timeoutSeconds: Schema.Number,
  /** Number of consecutive successful attempts before "healthy". */
  retries: Schema.Number,
  /** Optional grace period before first probe, seconds. */
  startPeriodSeconds: Schema.optional(Schema.Number),
});
export type HealthcheckPlan = typeof HealthcheckPlan.Type;

/**
 * Certificate plan — leaf certs the planner has reserved for this service.
 * SPEC: §6.8
 */
export const CertificatePlan = Schema.Struct({
  /** Common name. */
  cn: Schema.String,
  /** Subject Alt Names. */
  sans: Schema.Array(Schema.String),
  /** CA id this cert was issued by. */
  caId: Schema.String,
});
export type CertificatePlan = typeof CertificatePlan.Type;

/**
 * Host alias — extra `/etc/hosts` entry inside the service container.
 * SPEC: §6.6
 */
export const HostAliasPlan = Schema.Struct({
  hostname: Schema.String,
  ip: Schema.String,
});
export type HostAliasPlan = typeof HostAliasPlan.Type;

/**
 * Inter-service dependency. SPEC: §6.13.2
 */
export const DependencyPlan = Schema.Struct({
  /** The service this one depends on. */
  service: ServiceName,
  /** Whether the dependency must be `healthy` or merely `started`. */
  condition: Schema.Literal("started", "healthy"),
});
export type DependencyPlan = typeof DependencyPlan.Type;

/**
 * Network plan — provider-realized network. SPEC: §6.6
 */
export const NetworkPlan = Schema.Struct({
  /** Network name. */
  name: Schema.String,
  /** Whether this network is shared across apps. */
  shared: Schema.Boolean,
  /** Driver (provider-specific). */
  driver: Schema.optional(Schema.String),
});
export type NetworkPlan = typeof NetworkPlan.Type;

// =============================================================================
// Provider capabilities — the typed manifest of what a provider can do.
// SPEC: §5.4
// =============================================================================

export const ProviderCapabilities = Schema.Struct({
  artifactBuild: Schema.Boolean,
  artifactPull: Schema.Boolean,
  buildSecrets: Schema.Boolean,
  buildSsh: Schema.Boolean,
  multiServiceApply: Schema.Boolean,
  serviceExec: Schema.Boolean,
  serviceLogs: Schema.Boolean,
  serviceHealth: Schema.Literal("native", "lando", "none"),
  hostReachability: Schema.Literal("native", "emulated", "none"),
  sharedCrossAppNetwork: Schema.Boolean,
  persistentStorage: Schema.Boolean,
  bindMounts: Schema.Boolean,
  bindMountPerformance: Schema.Literal("native", "slow", "none"),
  copyMounts: Schema.Boolean,
  hostPortPublish: Schema.Literal("native", "proxy", "manual", "none"),
  routeProvider: Schema.Boolean,
  tlsCertificates: Schema.Literal("native", "lando", "none"),
  rootless: Schema.Boolean,
  privilegedServices: Schema.Boolean,
  composeSpec: Schema.Literal("none", "portable", "native"),
  providerExtensions: Schema.Array(Schema.String),
});
export type ProviderCapabilities = typeof ProviderCapabilities.Type;

// =============================================================================
// AppRef — shared identity field across App, Global, and Scratch event scopes.
// SPEC: §11.2 (carries `kind` discriminator splitting the identifier namespace
// across user, global, and scratch apps).
// =============================================================================

export const AppRef = Schema.Struct({
  /** Identity namespace this app belongs to. */
  kind: Schema.Literal("user", "global", "scratch"),
  /** User slug, the literal `"global"`, or a scratch id. */
  id: Schema.String,
  /**
   * Materialized app root (user app root, `<userDataRoot>/global/`, or
   * `<userCacheRoot>/scratch/<id>/root/`).
   */
  root: AbsolutePath,
});
export type AppRef = typeof AppRef.Type;

// =============================================================================
// ServicePlan + AppPlan — the frozen, schema-validated, provider-neutral
// description of what a provider must realize. SPEC: §5.5
// =============================================================================

export const ServicePlan = Schema.Struct({
  name: ServiceName,
  type: Schema.String,
  provider: ProviderId,
  primary: Schema.Boolean,
  artifact: Schema.optional(Schema.Union(ArtifactRef, ArtifactBuildSpec)),
  command: Schema.optional(CommandSpec),
  entrypoint: Schema.optional(CommandSpec),
  environment: Schema.Record({ key: Schema.String, value: Schema.String }),
  user: Schema.optional(Schema.String),
  workingDirectory: Schema.optional(PortablePath),
  appMount: Schema.optional(AppMountPlan),
  mounts: Schema.Array(MountPlan),
  storage: Schema.Array(DataStoreMountPlan),
  endpoints: Schema.Array(EndpointPlan),
  routes: Schema.Array(RouteRef),
  dependsOn: Schema.Array(DependencyPlan),
  healthcheck: Schema.optional(HealthcheckPlan),
  certs: Schema.optional(CertificatePlan),
  hostAliases: Schema.Array(HostAliasPlan),
  metadata: PlanMetadata,
  extensions: ProviderExtensionConfig,
});
export type ServicePlan = typeof ServicePlan.Type;

export const AppPlan = Schema.Struct({
  id: AppId,
  name: Schema.String,
  slug: Schema.String,
  root: AbsolutePath,
  provider: ProviderId,
  services: Schema.Record({ key: ServiceName, value: ServicePlan }),
  routes: Schema.Array(RoutePlan),
  networks: Schema.Array(NetworkPlan),
  stores: Schema.Array(DataStorePlan),
  metadata: PlanMetadata,
  extensions: ProviderExtensionConfig,
});
export type AppPlan = typeof AppPlan.Type;

// =============================================================================
// BuildPlan — DAG over BuildSteps, two phases (artifact + app). SPEC: §6.13
// =============================================================================

export const BuildPhase = Schema.Literal("artifact", "app");
export type BuildPhase = typeof BuildPhase.Type;

export const BuildStep = Schema.Struct({
  /** Stable id within the BuildPlan (`<service>:<phase>:<seq>`). */
  id: Schema.String,
  /** Service this step builds for. */
  service: ServiceName,
  /** Which phase this step belongs to. */
  phase: BuildPhase,
  /** Operation kind: pull/build artifact, or run a build script. */
  kind: Schema.Literal("buildArtifact", "pullArtifact", "execStream"),
  /** Build script (kind = execStream) — argv form. */
  command: Schema.optional(CommandSpec),
  /** Artifact spec (kind = buildArtifact / pullArtifact). */
  artifact: Schema.optional(Schema.Union(ArtifactRef, ArtifactBuildSpec)),
  /** Step ids this step depends on. */
  dependsOn: Schema.Array(Schema.String),
  /** Content-hash key for the up-to-date check (§6.13.5). */
  buildKey: Schema.String,
});
export type BuildStep = typeof BuildStep.Type;

export const BuildPlan = Schema.Struct({
  /** App this BuildPlan belongs to. */
  appId: AppId,
  /** Total step count (artifact + app). */
  totalSteps: Schema.Number,
  /** All steps, topologically orderable via `dependsOn`. */
  steps: Schema.Array(BuildStep),
  metadata: PlanMetadata,
});
export type BuildPlan = typeof BuildPlan.Type;

// =============================================================================
// Landofile input shape — what a user authors (services:, routes:, etc.).
// MVP subset of §7.4 + §6.2 — full shape lands as features stabilize.
// =============================================================================

/** Endpoint input as authored under `services.<name>.endpoints`. */
export const EndpointInput = Schema.Struct({
  port: Schema.optional(Schema.Number),
  protocol: Schema.Literal("http", "https", "tcp", "udp", "unix"),
  name: Schema.optional(Schema.String),
  socketPath: Schema.optional(Schema.String),
});
export type EndpointInput = typeof EndpointInput.Type;

/** Route input as authored under `services.<name>.routes` (or top-level `proxy:`). */
export const RouteInput = Schema.Struct({
  hostname: Schema.String,
  scheme: Schema.optional(Schema.Literal("http", "https", "both")),
  endpoint: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  pathPrefix: Schema.optional(Schema.String),
});
export type RouteInput = typeof RouteInput.Type;

/** Mount input — short ("./src:/app") or expanded form. */
export const MountInput = Schema.Union(
  Schema.String,
  Schema.Struct({
    type: Schema.optional(Schema.Literal("bind", "tmpfs", "volume")),
    source: Schema.optional(Schema.String),
    target: Schema.String,
    readOnly: Schema.optional(Schema.Boolean),
  }),
);
export type MountInput = typeof MountInput.Type;

/** Storage input — named volume reference (long form coming later). */
export const StorageInput = Schema.Union(
  Schema.String,
  Schema.Struct({
    store: Schema.String,
    target: Schema.String,
    readOnly: Schema.optional(Schema.Boolean),
    scope: Schema.optional(StorageScope),
  }),
);
export type StorageInput = typeof StorageInput.Type;

/** Healthcheck input as authored. */
export const HealthcheckInput = Schema.Struct({
  kind: Schema.optional(Schema.Literal("command", "http", "tcp", "none")),
  command: Schema.optional(CommandSpec),
  url: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  intervalSeconds: Schema.optional(Schema.Number),
  timeoutSeconds: Schema.optional(Schema.Number),
  retries: Schema.optional(Schema.Number),
  startPeriodSeconds: Schema.optional(Schema.Number),
});
export type HealthcheckInput = typeof HealthcheckInput.Type;

/** Build-script block authored under `services.<name>.build`. */
export const BuildBlock = Schema.Struct({
  artifact: Schema.optional(BuildScript),
  app: Schema.optional(BuildScript),
});
export type BuildBlock = typeof BuildBlock.Type;

/**
 * ServiceConfig — what a user authors under `services.<name>:` in a Landofile.
 * MVP subset: covers everything Phase 6/7/10 need to plan + provider-realize a
 * minimal app. Full §6.2 schema (compose passthrough, secrets, labels,
 * profiles, deploy, packages, security.ca:, env_file:) is deferred.
 */
export const ServiceConfig = Schema.Struct({
  api: Schema.optional(Schema.Literal(4)),
  type: Schema.optional(Schema.String), // defaults to "lando"
  primary: Schema.optional(Schema.Boolean),

  image: Schema.optional(Schema.String),
  build: Schema.optional(BuildBlock),
  command: Schema.optional(CommandSpec),
  entrypoint: Schema.optional(CommandSpec),
  user: Schema.optional(Schema.String),
  workingDirectory: Schema.optional(PortablePath),
  environment: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),

  ports: Schema.optional(Schema.Array(Schema.String)),
  volumes: Schema.optional(Schema.Array(Schema.String)),

  appMount: Schema.optional(
    Schema.Struct({
      target: Schema.String,
      readOnly: Schema.optional(Schema.Boolean),
      excludes: Schema.optional(Schema.Array(Schema.String)),
      includes: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  mounts: Schema.optional(Schema.Array(MountInput)),
  storage: Schema.optional(Schema.Array(StorageInput)),

  endpoints: Schema.optional(Schema.Array(EndpointInput)),
  routes: Schema.optional(Schema.Array(RouteInput)),

  healthcheck: Schema.optional(HealthcheckInput),
  hostnames: Schema.optional(Schema.Array(Schema.String)),
  dependsOn: Schema.optional(Schema.Array(Schema.String)),
});
export type ServiceConfig = typeof ServiceConfig.Type;

/**
 * LandofileShape — the authored Landofile. MVP subset of §7.4.
 * Deferred for later passes: tooling:, toolingDefaults:, toolingIncludes:,
 * commandAliases:, events:, env_file:, keys:, includes:, volumes:, networks:,
 * configs:, secrets:, include:, x-* extensions, plugins:, pluginDirs:.
 */
export const LandofileShape = Schema.Struct({
  name: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.Literal(4)),
  recipe: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderId),
  toolingEngine: Schema.optional(Schema.String),
  services: Schema.optional(Schema.Record({ key: ServiceName, value: ServiceConfig })),
  proxy: Schema.optional(Schema.Record({ key: ServiceName, value: Schema.Array(RouteInput) })),
  providers: Schema.optional(ProviderExtensionConfig),
});
export type LandofileShape = typeof LandofileShape.Type;

// =============================================================================
// Global config — the host-level merged config.
// SPEC: §7.5
// =============================================================================

/**
 * Telemetry opt-in. `enabled` defaults to `false` so a partial decode is
 * always safe.
 */
export const TelemetryConfig = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => false }),
});
export type TelemetryConfig = typeof TelemetryConfig.Type;

/**
 * GlobalConfig — MVP subset. Covers the four host-root fields the Phase 1
 * walking skeleton resolves at the `global` bootstrap level. Full §7.5
 * (envPrefix, domain, landoFile, pre/postLandoFiles, userCacheRoot,
 * systemPluginRoot, providers, plugins, pluginDirs, disablePlugins,
 * bindAddress, routing, network, logger, renderer, toolingEngine,
 * commandAliases, pluginConfig, keys, maxKeyWarning, scanner, healthcheck,
 * build, logLevelConsole, experimental, stats) is deferred.
 */
export const GlobalConfig = Schema.Struct({
  userDataRoot: Schema.optional(AbsolutePath),
  userConfRoot: Schema.optional(AbsolutePath),
  defaultProviderId: Schema.optional(Schema.Union(ProviderId, Schema.Null)),
  telemetry: Schema.optional(TelemetryConfig),
});
export type GlobalConfig = typeof GlobalConfig.Type;

// =============================================================================
// Plugin manifest — declared by every plugin's package.json + plugin.yaml.
// SPEC: §10.2
// =============================================================================

/** Contribution surface — keys the plugin contributes to. */
export const PluginContribution = Schema.Struct({
  /** Service types this plugin registers. */
  serviceTypes: Schema.optional(Schema.Array(Schema.String)),
  /** Service features this plugin registers. */
  serviceFeatures: Schema.optional(Schema.Array(Schema.String)),
  /** Provider ids registered. */
  providers: Schema.optional(Schema.Array(Schema.String)),
  /** Proxy ids registered. */
  proxies: Schema.optional(Schema.Array(Schema.String)),
  /** Logger ids registered. */
  loggers: Schema.optional(Schema.Array(Schema.String)),
  /** Renderer ids registered. */
  renderers: Schema.optional(Schema.Array(Schema.String)),
  /** Template engine ids registered. */
  templateEngines: Schema.optional(Schema.Array(Schema.String)),
  /** File-sync engine ids registered. */
  fileSyncEngines: Schema.optional(Schema.Array(Schema.String)),
  /** CA ids registered. */
  cas: Schema.optional(Schema.Array(Schema.String)),
  /** Built-in commands registered. */
  commands: Schema.optional(Schema.Array(Schema.String)),
});
export type PluginContribution = typeof PluginContribution.Type;

export const PluginManifest = Schema.Struct({
  name: PluginName,
  version: Schema.String,
  api: Schema.Literal(4),
  description: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  bundled: Schema.optional(Schema.Boolean),
  contributes: Schema.optional(PluginContribution),
  /** Entry module path relative to plugin package root. */
  entry: Schema.optional(Schema.String),
});
export type PluginManifest = typeof PluginManifest.Type;

// =============================================================================
// ServiceInfo — provider-neutral runtime info returned by `lando info`.
// SPEC: §6.10
// =============================================================================

export const ServiceInfo = Schema.Struct({
  app: Schema.String,
  service: Schema.String,
  api: Schema.Literal(4),
  type: Schema.String,
  provider: Schema.String,
  primary: Schema.Boolean,
  status: Schema.Literal("unknown", "stopped", "starting", "running", "healthy", "unhealthy", "error"),
  /** Resolved endpoints (host-reachable). */
  endpoints: Schema.optional(Schema.Array(EndpointPlan)),
  /** Resolved routes pointing at this service. */
  routes: Schema.optional(Schema.Array(RoutePlan)),
});
export type ServiceInfo = typeof ServiceInfo.Type;

// =============================================================================
// Recipe manifest — interface only for MVP (recipe model is deferred).
// SPEC: §8.8
// =============================================================================

export const RecipeManifest = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** Recipe-version semver. */
  version: Schema.optional(Schema.String),
  /** Plugins this recipe requires. */
  requires: Schema.optional(Schema.Array(Schema.String)),
});
export type RecipeManifest = typeof RecipeManifest.Type;

// =============================================================================
// Template render context — passed to TemplateEngine.render. SPEC: §7.3.2
// =============================================================================

export const TemplateRenderContext = Schema.Struct({
  /** Bootstrap level the renderer is running at. */
  bootstrapLevel: BootstrapLevel,
  /** App root (when known). */
  appRoot: Schema.optional(AbsolutePath),
  /** Effective env at render time. */
  env: Schema.Record({ key: Schema.String, value: Schema.String }),
  /** Resolved global config snapshot (immutable). */
  global: Schema.optional(GlobalConfig),
  /** Resolved Landofile (immutable). */
  landofile: Schema.optional(LandofileShape),
  /** Provider id, if selected. */
  provider: Schema.optional(ProviderId),
  /** Render scope tag for cache keying (`landofile`, `recipe`, `mount`, …). */
  scope: Schema.String,
});
export type TemplateRenderContext = typeof TemplateRenderContext.Type;
