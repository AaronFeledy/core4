import { Schema } from "effect";

import { BuildScript } from "./artifacts.ts";
import { StorageScope } from "./mounts.ts";
import { CommandSpec, PortablePath, ProviderExtensionConfig, ProviderId, ServiceName } from "./primitives.ts";

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

/** Storage input — named volume reference. */
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
 * Covers the fields consumed by downstream provider logic.
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
  cores: Schema.optional(Schema.Array(Schema.String)),
  port: Schema.optional(Schema.Number),
  framework: Schema.optional(Schema.String),
  root: Schema.optional(Schema.String),
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

  ports: Schema.optional(
    Schema.Array(
      Schema.transform(Schema.Union(Schema.String, Schema.Number), Schema.String, {
        strict: true,
        decode: String,
        encode: (s) => s,
      }),
    ),
  ),
  volumes: Schema.optional(Schema.Array(Schema.String)),

  appMount: Schema.optional(
    Schema.Union(
      Schema.Literal(false),
      Schema.Struct({
        target: Schema.String,
        readOnly: Schema.optional(Schema.Boolean),
        excludes: Schema.optional(Schema.Array(Schema.String)),
        includes: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
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
 * ToolingVar — var forms accepted by this schema. Unsupported
 * surfaces such as unsafe `{ raw: ... }` interpolation and remote-source vars
 * are rejected before schema decode with a tagged
 * `NotImplementedError`.
 */
export const ToolingVar = Schema.Union(ToolingVarLiteral, ToolingVarDefault, ToolingVarSh, ToolingVarPrompt);
export type ToolingVar = typeof ToolingVar.Type;

/**
 * ToolingTaskShape — Landofile `tooling.<name>` task entry accepted by this
 * schema.
 *
 * Accepted fields:
 * - `service:` — fixed service target (or `:host` / `:<flag-name>`).
 * - `description:` / `summary:` — short help text.
 * - `cmd:` — single command (string or string array).
 * - `cmds:` — sequential command list (strings only in this schema).
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
 * script body.
 *
 * Accepted fields (matching `ToolingTaskShape`):
 * - `service:` — fixed service target (or `:host` / `:<flag-name>`).
 *   Defaults to `:host` when omitted.
 * - `desc:` / `description:` / `summary:` — short help text. `desc` is
 *   accepted as an alias for `description` by script-backed tooling.
 *
 * Unsupported fields (`aliases`, `topLevelAlias`, `bootstrap`,
 * `flags`, `args`, `passThrough`, `sources`, `generates`, `status`,
 * `preconditions`, `run`, `platforms`, `internal`, `disabled`,
 * `engine`) are detected pre-decode (including nested YAML list/object
 * forms like `sources:\n  - …`) and rejected with a tagged
 * `NotImplementedError` carrying `commandId: "landofile.parse"`, the
 * matching schema metadata and targeted remediation. Unknown keys
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

export const IncludeEntry = Schema.Union(
  Schema.String,
  Schema.Struct({
    source: Schema.String,
    kind: Schema.optional(Schema.Literal("landofile")),
    path: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
    checksum: Schema.optional(Schema.String),
  }),
);
export type IncludeEntry = typeof IncludeEntry.Type;

export const ComposeSecretConfig = Schema.Struct({
  file: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
  external: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
});
export type ComposeSecretConfig = typeof ComposeSecretConfig.Type;

export const COMPOSE_TOP_LEVEL_KEYS = [
  "services",
  "volumes",
  "networks",
  "configs",
  "secrets",
  "include",
] as const;
export const COMPOSE_DEPRECATED_TOP_LEVEL_KEYS = ["version"] as const;
export const COMPOSE_EXTENSION_TOP_LEVEL_PATTERN = "x-*" as const;
export const COMPOSE_TOP_LEVEL_ACCEPTED_DISPLAY = `${COMPOSE_TOP_LEVEL_KEYS.join(", ")}, ${COMPOSE_EXTENSION_TOP_LEVEL_PATTERN}`;

const ComposeNamedResourceConfig = Schema.Struct({
  name: Schema.optional(Schema.String),
  external: Schema.optional(Schema.Boolean),
  driver: Schema.optional(Schema.String),
});

const ComposeConfigConfig = Schema.Struct({
  file: Schema.optional(Schema.String),
  external: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
});

/**
 * LandofileShape — the authored Landofile shape.
 * Excludes fields not modeled here: toolingDefaults:, toolingIncludes:,
 * commandAliases:, events:, env_file:, keys:, plugins:, pluginDirs:.
 */
const LandofileShapeBase = Schema.Struct({
  name: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.Literal(4)),
  recipe: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderId),
  toolingEngine: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  includes: Schema.optional(Schema.Array(IncludeEntry)),
  include: Schema.optional(Schema.Array(Schema.String)),
  volumes: Schema.optional(Schema.Record({ key: Schema.String, value: ComposeNamedResourceConfig })),
  networks: Schema.optional(Schema.Record({ key: Schema.String, value: ComposeNamedResourceConfig })),
  configs: Schema.optional(Schema.Record({ key: Schema.String, value: ComposeConfigConfig })),
  secrets: Schema.optional(Schema.Record({ key: Schema.String, value: ComposeSecretConfig })),
  services: Schema.optional(Schema.Record({ key: ServiceName, value: ServiceConfig })),
  proxy: Schema.optional(Schema.Record({ key: ServiceName, value: Schema.Array(RouteInput) })),
  providers: Schema.optional(ProviderExtensionConfig),
  tooling: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingTaskShape })),
});

export const LandofileShape = Schema.asSchema(
  LandofileShapeBase.pipe(
    Schema.extend(Schema.Record({ key: Schema.TemplateLiteral("x-", Schema.String), value: Schema.Unknown })),
  ),
);
export type LandofileShape = typeof LandofileShape.Type;

export const defineLandofile = <T extends LandofileShape>(value: T): T => value;
