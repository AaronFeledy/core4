/** Public Effect schemas for SDK contracts. */
import { JSONSchema, Schema } from "effect";

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

export const HostPlatform = Schema.Literal("darwin", "linux", "win32", "wsl");
export type HostPlatform = typeof HostPlatform.Type;

export const HostArchitecture = Schema.Literal("x64", "arm64");
export type HostArchitecture = typeof HostArchitecture.Type;

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

/**
 * Plan metadata — every plan node carries this for traceability.
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
 */
export const ProviderExtensionConfig = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
export type ProviderExtensionConfig = typeof ProviderExtensionConfig.Type;

/**
 * `command` / `entrypoint` accept either a single string or an argv array.
 */
export const CommandSpec = Schema.Union(Schema.String, Schema.Array(Schema.String));
export type CommandSpec = typeof CommandSpec.Type;

/**
 * Reference to a pre-built artifact (image, template, etc.) the provider
 * should pull rather than build.
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
 * source.
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
  /** Content hash for buildKey computation. */
  contentHash: Schema.optional(Schema.String),
});
export type ArtifactBuildSpec = typeof ArtifactBuildSpec.Type;

/** Build script for `build.artifact:` and `build.app:` entries. */
export const BuildScript = Schema.Union(Schema.String, Schema.Array(Schema.String));
export type BuildScript = typeof BuildScript.Type;

/**
 * App mount — the special mount of the app source root into the service.
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
   * `accelerated` — routed through the active FileSyncEngine.
   */
  realization: Schema.Literal("passthrough", "accelerated"),
});
export type AppMountPlan = typeof AppMountPlan.Type;

/**
 * Generic mount plan — any non-app, non-storage mount.
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
 */
export const StorageScope = Schema.Literal("service", "app", "global");
export type StorageScope = typeof StorageScope.Type;

/**
 * Data store — a named, persistent volume the provider must create.
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
 * Mount of a `DataStorePlan` into a service.
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
 * Endpoint — a service listener.
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
 */
export const RouteRef = Schema.Struct({
  index: Schema.Number,
});
export type RouteRef = typeof RouteRef.Type;

/**
 * Route plan — host-facing HTTP/TLS mapping.
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
 * Healthcheck — provider-realized health probe.
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
 */
export const HostAliasPlan = Schema.Struct({
  hostname: Schema.String,
  ip: Schema.String,
});
export type HostAliasPlan = typeof HostAliasPlan.Type;

/**
 * Inter-service dependency.
 */
export const DependencyPlan = Schema.Struct({
  /** The service this one depends on. */
  service: ServiceName,
  /** Whether the dependency must be `healthy` or merely `started`. */
  condition: Schema.Literal("started", "healthy"),
});
export type DependencyPlan = typeof DependencyPlan.Type;

/**
 * Network plan — provider-realized network.
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

// Provider capabilities — the typed manifest of what a provider can do.

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

// AppRef — shared identity field across App, Global, and Scratch event scopes.
// Carries `kind` discriminator splitting the identifier namespace across user,
// global, and scratch apps.

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

// ServicePlan + AppPlan — the frozen, schema-validated, provider-neutral
// Description of what a provider must realize.

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

// BuildPlan — DAG over BuildSteps for artifact and app work.

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
  /** Content-hash key for the up-to-date check. */
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

// Landofile input shape — what a user authors (services:, routes:, etc.).

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
    /** Excludes (gitignore-flavoured) — bind only; realized as volume shadows. */
    excludes: Schema.optional(Schema.Array(Schema.String)),
    /** Includes — re-bind specific excluded paths. */
    includes: Schema.optional(Schema.Array(Schema.String)),
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
 * Covers the fields currently consumed by the planner and provider layers.
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
  database: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  framework: Schema.optional(Schema.String),
  // Accept number/boolean values from YAML auto-typing and coerce to string.
  environment: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.transform(Schema.Union(Schema.String, Schema.Number, Schema.Boolean), Schema.String, {
        strict: true,
        decode: String,
        encode: (s) => s,
      }),
    }),
  ),

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

  composeBuild: Schema.optional(
    Schema.Struct({
      context: Schema.String,
      dockerfile: Schema.optional(Schema.String),
      args: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
      target: Schema.optional(Schema.String),
    }),
  ),

  providers: Schema.optional(ProviderExtensionConfig),
});
export type ServiceConfig = typeof ServiceConfig.Type;

/**
 * ToolingVarLiteral — a scalar literal value for a Landofile `tooling.<task>.vars.<name>`.
 */
export const ToolingVarLiteral = Schema.Union(Schema.String, Schema.Number, Schema.Boolean);
export type ToolingVarLiteral = typeof ToolingVarLiteral.Type;

/**
 * ToolingVarDefault — `vars.<name>: { default: <literal> }`.
 */
export const ToolingVarDefault = Schema.Struct({ default: ToolingVarLiteral });
export type ToolingVarDefault = typeof ToolingVarDefault.Type;

/**
 * ToolingVarSh — `vars.<name>: { sh: <command> }`. Evaluated at task
 * invocation time via the task's selected engine.
 */
export const ToolingVarSh = Schema.Struct({ sh: Schema.String });
export type ToolingVarSh = typeof ToolingVarSh.Type;

/**
 * ToolingVarPrompt — `vars.<name>: { prompt: <message> }`. Resolved at task
 * invocation time by prompting the user.
 */
export const ToolingVarPrompt = Schema.Struct({ prompt: Schema.String });
export type ToolingVarPrompt = typeof ToolingVarPrompt.Type;

/**
 * ToolingVar — Alpha-supported var forms only. Beta-deferred surfaces such
 * as unsafe `{ raw: ... }` interpolation and remote-source vars are
 * rejected by `LandofileService` before schema decode with a tagged
 * `NotImplementedError`.
 */
export const ToolingVar = Schema.Union(ToolingVarLiteral, ToolingVarDefault, ToolingVarSh, ToolingVarPrompt);
export type ToolingVar = typeof ToolingVar.Type;

/**
 * ToolingTaskShape — Alpha-supported Landofile `tooling.<name>` task entry.
 *
 * Alpha-supported fields:
 * - `service:` — fixed service target (or `:host` / `:<flag-name>`).
 * - `description:` / `summary:` — short help text.
 * - `cmd:` — single command (string or string array).
 * - `cmds:` — sequential command list (strings only in the current loader).
 * - `vars:` — accepted `ToolingVar` forms only.
 *
 * Unsupported fields rejected by `LandofileService` with remediation:
 * `deps:`, step-objects in `cmds:` (`task:`, `command:`, `defer:`,
 * `for:`, `cmd:` step overrides), `engine:`, `bootstrap:`, `dotenv:`,
 * `env:`, `user:`, `dir:`, `appMount:`, `stdio:`, `interactive:`,
 * `passThrough:`, `sources:`, `generates:`, `method:`, `status:`,
 * `preconditions:`, `if:`, `run:`, `platforms:`, `prompt:` (task-level),
 * `silent:`, `output:`, `failFast:`, `disabled:`, `aliases:`,
 * `topLevelAlias:`, `namespace:`, `internal:`, `hostProxyAllowed:`,
 * `deprecated:`, `flags:`, `args:`, `examples:`, `usage:`.
 */
export const ToolingTaskShape = Schema.Struct({
  service: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  cmd: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
  cmds: Schema.optional(Schema.Array(Schema.String)),
  vars: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingVar })),
});
export type ToolingTaskShape = typeof ToolingTaskShape.Type;

/**
 * BunShellScriptFrontMatter — accepted YAML front-matter for
 * `.lando/scripts/<name>.bun.sh` script-backed tooling tasks.
 *
 * The front-matter is the first contiguous comment block at the top of a
 * `.bun.sh` file, wrapped in `# ---` markers and uniformly prefixed with
 * `# `. It supplies the same metadata fields a `tooling:` entry would,
 * but the script body itself is the task body — `cmd:` / `cmds:` /
 * `vars:` are intentionally absent because they live inline in the
 * script.
 *
 * Alpha-supported fields (matching `ToolingTaskShape`):
 * - `service:` — fixed service target (or `:host` / `:<flag-name>`).
 *   Defaults to `:host` when omitted.
 * - `desc:` / `description:` / `summary:` — short help text. `desc` is
 *   accepted as an alias for `description` by script-backed tooling.
 *   list.
 *
 * Beta-deferred fields (`aliases`, `topLevelAlias`, `bootstrap`,
 * `flags`, `args`, `passThrough`, `sources`, `generates`, `status`,
 * `preconditions`, `run`, `platforms`, `internal`, `disabled`,
 * `engine`) are detected pre-decode (including nested YAML list/object
 * forms like `sources:\n  - …`) and rejected with a tagged
 * `NotImplementedError` carrying `commandId: "landofile.parse"`, the
 * matching `specSection`, and a deferral remediation. Unknown keys
 * outside that set fall through to the strict schema decode and surface
 * as `BunShellScriptFrontMatterError`.
 */
export const BunShellScriptFrontMatter = Schema.Struct({
  service: Schema.optional(Schema.String),
  desc: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
});
export type BunShellScriptFrontMatter = typeof BunShellScriptFrontMatter.Type;

/**
 * LandofileShape — the authored Landofile accepted by the planner.
 * Deferred for later passes: toolingDefaults:, toolingIncludes:,
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
  tooling: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingTaskShape })),
});
export type LandofileShape = typeof LandofileShape.Type;

export const defineLandofile = <T extends LandofileShape>(value: T): T => value;

// Global config — the host-level merged config.

/**
 * Telemetry opt-in. `enabled` defaults to `false` so a partial decode is
 * always safe.
 */
export const TelemetryConfig = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => false }),
});
export type TelemetryConfig = typeof TelemetryConfig.Type;

/**
 * GlobalConfig — host-root fields resolved at the `global` bootstrap level.
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
  telemetry: Schema.optionalWith(TelemetryConfig, { default: () => ({ enabled: false }) }),
});
export type GlobalConfig = typeof GlobalConfig.Type;

// Plugin manifest — declared by every plugin's package.json + plugin.yaml.

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

// ServiceInfo — provider-neutral runtime info returned by `lando info`.

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

// Recipe manifest schema with prompt and post-init action shapes.
// Unsupported fields (`runs:`, `fetchAllowlist:`, `choicesFrom:`,
// `editor` prompt type, non-`install` `bun:` verbs) are intentionally absent
// from the schema and are surfaced as `NotImplementedError` by the loader
// before strict decode so users see a targeted remediation instead of a
// generic excess-property error.

const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Recipe id — kebab-case identifier; matches directory basename. */
export const RecipeId = Schema.String.pipe(
  Schema.pattern(KEBAB_CASE_PATTERN, {
    message: () => "Recipe id must be lowercase kebab-case (a-z, 0-9, hyphen).",
  }),
);
export type RecipeId = typeof RecipeId.Type;

/** Recipe semver string. */
export const RecipeVersion = Schema.String.pipe(
  Schema.pattern(SEMVER_PATTERN, {
    message: () => "Recipe version must be a semver string (e.g. 1.0.0).",
  }),
);
export type RecipeVersion = typeof RecipeVersion.Type;

/** Recipe-prompt type supported by the current loader (`editor` is rejected before decode). */
export const RecipePromptType = Schema.Literal(
  "text",
  "select",
  "multiselect",
  "confirm",
  "number",
  "secret",
  "path",
);
export type RecipePromptType = typeof RecipePromptType.Type;

/** Recipe-prompt choice — bare value or labeled object. */
export const RecipePromptChoice = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Struct({
    value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
    label: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  }),
);
export type RecipePromptChoice = typeof RecipePromptChoice.Type;

/** Recipe-prompt validation — per-type validator keys. */
export const RecipePromptValidate = Schema.Struct({
  pattern: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  exists: Schema.optional(Schema.Boolean),
});
export type RecipePromptValidate = typeof RecipePromptValidate.Type;

/** Recipe prompt. */
export const RecipePrompt = Schema.Struct({
  name: Schema.String,
  type: RecipePromptType,
  message: Schema.String,
  default: Schema.optional(Schema.Union(Schema.String, Schema.Number, Schema.Boolean)),
  when: Schema.optional(Schema.String),
  validate: Schema.optional(RecipePromptValidate),
  choices: Schema.optional(Schema.Array(RecipePromptChoice)),
});
export type RecipePrompt = typeof RecipePrompt.Type;

/** Recipe file-manifest entry. */
export const RecipeFile = Schema.Struct({
  src: Schema.String,
  dest: Schema.String,
  when: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  template: Schema.optional(Schema.Boolean),
  engine: Schema.optional(Schema.String),
});
export type RecipeFile = typeof RecipeFile.Type;

/** Recipe post-init `gitInit` action. */
export const RecipePostInitGitInit = Schema.Struct({
  type: Schema.Literal("gitInit"),
  when: Schema.optional(Schema.String),
});

/** Recipe post-init `message` action. */
export const RecipePostInitMessage = Schema.Struct({
  type: Schema.Literal("message"),
  text: Schema.String,
  when: Schema.optional(Schema.String),
});

/** Recipe post-init `command` action — canonical Lando id from the recipe allowlist. */
export const RecipePostInitCommand = Schema.Struct({
  type: Schema.Literal("command"),
  cmd: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  when: Schema.optional(Schema.String),
});

/** Recipe post-init `bun` action — supported verbs only. */
export const RecipePostInitBun = Schema.Struct({
  type: Schema.Literal("bun"),
  /** Other verbs are surfaced as NotImplementedError before decode. */
  verb: Schema.Literal("install"),
  cwd: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
});

/** Recipe post-init action — discriminated by `type`. */
export const RecipePostInitAction = Schema.Union(
  RecipePostInitGitInit,
  RecipePostInitMessage,
  RecipePostInitCommand,
  RecipePostInitBun,
);
export type RecipePostInitAction = typeof RecipePostInitAction.Type;

/** Recipe requires — supported pre-conditions (`runs:` / `fetchAllowlist:` are rejected before decode). */
export const RecipeRequires = Schema.Struct({
  lando: Schema.optional(Schema.String),
  hostTools: Schema.optional(Schema.Array(Schema.String)),
});
export type RecipeRequires = typeof RecipeRequires.Type;

/** Recipe manifest — the parsed `recipe.yml`. */
export const RecipeManifest = Schema.Struct({
  id: RecipeId,
  title: Schema.String,
  description: Schema.String,
  version: RecipeVersion,
  authors: Schema.optional(Schema.Array(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  requires: Schema.optional(RecipeRequires),
  prompts: Schema.optional(Schema.Array(RecipePrompt)),
  files: Schema.optional(Schema.Array(RecipeFile)),
  postInit: Schema.optional(Schema.Array(RecipePostInitAction)),
});
export type RecipeManifest = typeof RecipeManifest.Type;

// Template render context — passed to TemplateEngine.render.

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

// JSON Schema accessors.

const JSON_SCHEMA_REGISTRY = {
  BootstrapLevel,
  AppRef,
  AppPlan,
  ServicePlan,
  ProviderCapabilities,
  LandofileShape,
  GlobalConfig,
  AppId,
  ServiceName,
  ProviderId,
  HostPlatform,
  ServiceInfo,
  PluginManifest,
} as const;

export type JsonSchemaName = keyof typeof JSON_SCHEMA_REGISTRY;

export const getJsonSchema = (schemaName: JsonSchemaName) => {
  switch (schemaName) {
    case "BootstrapLevel":
      return JSONSchema.make(BootstrapLevel);
    case "AppRef":
      return JSONSchema.make(AppRef);
    case "AppPlan":
      return JSONSchema.make(AppPlan);
    case "ServicePlan":
      return JSONSchema.make(ServicePlan);
    case "ProviderCapabilities":
      return JSONSchema.make(ProviderCapabilities);
    case "LandofileShape":
      return JSONSchema.make(LandofileShape);
    case "GlobalConfig":
      return JSONSchema.make(GlobalConfig);
    case "AppId":
      return JSONSchema.make(AppId);
    case "ServiceName":
      return JSONSchema.make(ServiceName);
    case "ProviderId":
      return JSONSchema.make(ProviderId);
    case "HostPlatform":
      return JSONSchema.make(HostPlatform);
    case "ServiceInfo":
      return JSONSchema.make(ServiceInfo);
    case "PluginManifest":
      return JSONSchema.make(PluginManifest);
  }
};
