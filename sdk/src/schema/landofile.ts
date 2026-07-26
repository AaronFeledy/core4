import { ParseResult, Schema } from "effect";
import type * as AST from "effect/SchemaAST";
import validRange from "semver/ranges/valid.js";

import { BuildScript } from "./artifacts.ts";
import { DeprecationNotice } from "./deprecation.ts";
import { EndpointInput } from "./endpoint.ts";
import { LogSourceInput } from "./log-source.ts";
import { StorageScope } from "./mounts.ts";
import { CommandSpec, PortablePath, ProviderExtensionConfig, ProviderId, ServiceName } from "./primitives.ts";
import { DatasetBinding, RemoteConfig } from "./remote-sync.ts";

// Landofile input shape — what a user authors (services:, routes:, etc.).

export { EndpointInput } from "./endpoint.ts";

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
    kind: Schema.optional(Schema.Literal("data", "cache")),
    key: Schema.optional(Schema.String),
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

/** Compose `depends_on` condition vocabulary (§6.13). */
export const ServiceDependencyCondition = Schema.Literal(
  "service_started",
  "service_healthy",
  "service_completed_successfully",
).annotations({
  identifier: "ServiceDependencyCondition",
  title: "Service Dependency Condition",
  description:
    "How a service dependency must be satisfied before dependents start: on process start, on healthcheck success, or on successful completion.",
});
export type ServiceDependencyCondition = typeof ServiceDependencyCondition.Type;

/**
 * ServiceDependency — the canonical long form of a `dependsOn` / `depends_on`
 * entry. Both the string-list form and the Compose condition-map form
 * canonicalize to an array of these.
 */
export const ServiceDependency = Schema.Struct({
  service: Schema.String,
  condition: Schema.optional(ServiceDependencyCondition),
  required: Schema.optional(Schema.Boolean),
  restart: Schema.optional(Schema.Boolean),
}).annotations({
  identifier: "ServiceDependency",
  title: "Service Dependency",
  description:
    "A single inter-service dependency with its optional Compose condition, required, and restart flags.",
});
export type ServiceDependency = typeof ServiceDependency.Type;

/** Value shape of a Compose `depends_on` condition-map entry. */
const ServiceDependencyInput = Schema.Struct({
  condition: ServiceDependencyCondition,
  required: Schema.optional(Schema.Boolean),
  restart: Schema.optional(Schema.Boolean),
});

const RESERVED_KEY_PROPERTY_NAMES = { not: { const: "__proto__" } } as const;

const ReservedCoercedStringMapInput = Schema.Unknown.annotations({
  jsonSchema: {
    type: "object",
    propertyNames: RESERVED_KEY_PROPERTY_NAMES,
    additionalProperties: {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
    },
  },
});

const ReservedDependencyMapInput = Schema.Unknown.annotations({
  jsonSchema: {
    type: "object",
    propertyNames: RESERVED_KEY_PROPERTY_NAMES,
    additionalProperties: {
      type: "object",
      required: ["condition"],
      properties: {
        condition: {
          type: "string",
          enum: ["service_started", "service_healthy", "service_completed_successfully"],
        },
        required: { type: "boolean" },
        restart: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
});

const reservedMapKeyFailure = (input: unknown, ast: AST.Transformation) =>
  ParseResult.fail(
    new ParseResult.Type(
      ast,
      input,
      'The key "__proto__" is reserved and cannot be used in a Landofile map; choose another key.',
    ),
  );

const decodeReservedKeyMap = (input: unknown, ast: AST.Transformation) =>
  typeof input === "object" && input !== null && Object.hasOwn(input, "__proto__")
    ? reservedMapKeyFailure(input, ast)
    : ParseResult.succeed(input);

const StringRecord = Schema.Record({ key: Schema.String, value: Schema.String });

const ServiceDependencyInputRecord = Schema.transformOrFail(
  ReservedDependencyMapInput,
  Schema.Record({ key: Schema.String, value: ServiceDependencyInput }),
  {
    strict: false,
    decode: (input, _options, ast) => decodeReservedKeyMap(input, ast),
    encode: (record) => ParseResult.succeed(record),
  },
);

/** Record whose values coerce YAML scalars to strings. */
const CoercedStringRecord = Schema.transformOrFail(
  ReservedCoercedStringMapInput,
  Schema.Record({
    key: Schema.String,
    value: Schema.transform(Schema.Union(Schema.String, Schema.Number, Schema.Boolean), Schema.String, {
      strict: true,
      decode: String,
      encode: (s) => s,
    }),
  }),
  {
    strict: false,
    decode: (input, _options, ast) => decodeReservedKeyMap(input, ast),
    encode: (record) => ParseResult.succeed(record),
  },
);

/**
 * `environment` — accepts a map (`KEY: value`) or a Compose `KEY=value` list,
 * canonicalizing to a map. A bare list entry without `=` is rejected: Landofiles
 * do not read host environment variables, so there is no value to interpolate.
 */
const ComposeEnvironmentInput = Schema.transformOrFail(
  Schema.Union(CoercedStringRecord, Schema.Array(Schema.String)),
  StringRecord,
  {
    strict: true,
    decode: (input, _options, ast) => {
      if (!Array.isArray(input)) return ParseResult.succeed(input as Record<string, string>);
      const entries: Array<readonly [string, string]> = [];
      for (const entry of input) {
        const separator = entry.indexOf("=");
        if (separator < 0) {
          return ParseResult.fail(
            new ParseResult.Type(
              ast,
              input,
              `Landofile service environment entry "${entry}" must be KEY=value; host-environment interpolation is unsupported in Landofiles — use the map form (environment: { KEY: value }).`,
            ),
          );
        }
        entries.push([entry.slice(0, separator), entry.slice(separator + 1)]);
      }
      const record = Object.fromEntries(entries);
      if (Object.hasOwn(record, "__proto__")) return reservedMapKeyFailure(record, ast);
      return ParseResult.succeed(record);
    },
    encode: (record) => ParseResult.succeed(record),
  },
).annotations({
  description:
    "Service environment variables as a map (KEY: value) or a Compose-style KEY=value list. A bare list entry without '=' is rejected because Landofiles do not read host environment variables.",
});

/** `labels` — accepts a map or a Compose `KEY=value` list, canonicalizing to a map (bare entry → empty value). */
const ComposeLabelsInput = Schema.transformOrFail(
  Schema.Union(CoercedStringRecord, Schema.Array(Schema.String)),
  StringRecord,
  {
    strict: true,
    decode: (input, _options, ast) => {
      if (!Array.isArray(input)) return ParseResult.succeed(input);
      const record = Object.fromEntries(
        input.map((entry) => {
          const separator = entry.indexOf("=");
          return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
      );
      if (Object.hasOwn(record, "__proto__")) return reservedMapKeyFailure(record, ast);
      return ParseResult.succeed(record);
    },
    encode: (record) => ParseResult.succeed(record),
  },
).annotations({
  description: "Service labels as a map or a Compose-style KEY=value list; canonicalized to a map.",
});

/** `envFile` / Compose `env_file` — accepts a string or string list, canonicalizing to a list. */
const ComposeEnvFileInput = Schema.transform(
  Schema.Union(Schema.String, Schema.Array(Schema.String)),
  Schema.Array(Schema.String),
  {
    strict: true,
    decode: (input) => (typeof input === "string" ? [input] : input),
    encode: (list) => list,
  },
).annotations({
  description:
    "One or more env-file paths whose KEY=value lines seed the service environment. String or string list.",
});

/**
 * `dependsOn` / Compose `depends_on` — accepts a service-name list or a
 * condition-map (`{ <svc>: { condition, required?, restart? } }`) and
 * canonicalizes to an array of {@link ServiceDependency}.
 */
const ComposeDependsOnInput = Schema.transformOrFail(
  Schema.Union(Schema.Array(Schema.String), ServiceDependencyInputRecord, Schema.Array(ServiceDependency)),
  Schema.Array(ServiceDependency),
  {
    strict: false,
    decode: (input) => {
      if (Array.isArray(input)) {
        return ParseResult.succeed(
          input.map((entry) => (typeof entry === "string" ? { service: entry } : entry)),
        );
      }
      return ParseResult.succeed(Object.entries(input).map(([service, spec]) => ({ service, ...spec })));
    },
    encode: (deps: ReadonlyArray<ServiceDependency>, _options, ast) => {
      const allBare = deps.every(
        (dep) => dep.condition === undefined && dep.required === undefined && dep.restart === undefined,
      );
      if (allBare) return ParseResult.succeed(deps.map((dep) => dep.service));
      const reserved = deps.find((dep) => dep.service === "__proto__");
      if (reserved !== undefined) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            deps,
            'The dependency service "__proto__" cannot be encoded as a map key; choose another service name.',
          ),
        );
      }
      return ParseResult.succeed(
        Object.fromEntries(
          deps.map((dep) => {
            const { service, ...rest } = dep;
            return [service, { ...rest, condition: rest.condition ?? "service_started" }];
          }),
        ),
      );
    },
  },
).annotations({
  description:
    "Inter-service dependencies as a service-name list or a Compose condition-map; canonicalized to structured entries.",
});

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
  webroot: Schema.optional(PortablePath).annotations({
    description: "Container path served as this service's HTTP document root.",
  }),
  allowOverride: Schema.optional(Schema.Boolean).annotations({
    description: "Whether an Apache-backed service enables .htaccess overrides for its webroot.",
  }),
  root: Schema.optional(Schema.String),
  environment: Schema.optional(ComposeEnvironmentInput),
  envFile: Schema.optional(ComposeEnvFileInput).annotations({
    description:
      "One or more env-file paths (string or list) whose KEY=value lines seed the service environment.",
  }),
  labels: Schema.optional(ComposeLabelsInput).annotations({
    description: "Service labels as a map or a Compose-style KEY=value list; canonicalized to a map.",
  }),

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
  logs: Schema.optional(Schema.Array(LogSourceInput)),
  hostnames: Schema.optional(Schema.Array(Schema.String)),
  dependsOn: Schema.optional(ComposeDependsOnInput),

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
 * ServiceConfigInput — the accepted authoring surface: every {@link ServiceConfig}
 * key plus the Compose cross-key spellings (`working_dir`, `env_file`,
 * `depends_on`). Used as the decode boundary for `services.<name>:`.
 */
export const ServiceConfigInput = Schema.extend(
  Schema.encodedBoundSchema(ServiceConfig),
  Schema.Struct({
    working_dir: Schema.optional(PortablePath).annotations({
      description: "Compose alias for the canonical workingDirectory service field.",
    }),
    env_file: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))).annotations({
      description: "Compose alias for the canonical envFile service field; accepts one path or a path list.",
    }),
    depends_on: Schema.optional(
      Schema.Union(Schema.Array(Schema.String), ServiceDependencyInputRecord),
    ).annotations({
      description:
        "Compose alias for the canonical dependsOn service field; accepts a service-name list or condition map.",
    }),
  }),
).annotations({
  identifier: "ServiceConfigInput",
  title: "Service Config Input",
  description:
    "Accepted Landofile service authoring surface with canonical keys and the working_dir, env_file, and depends_on Compose aliases.",
});
export type ServiceConfigInput = typeof ServiceConfigInput.Type;

/**
 * ServiceConfigDecode — canonicalizes Compose cross-key spellings to their Lando
 * aliases, with the Lando key winning when both are present, then hands off to
 * {@link ServiceConfig} for per-key form canonicalization. Its input is the
 * encoded {@link ServiceConfig} surface plus the Compose spellings, so the
 * per-field transforms run once, inside {@link ServiceConfig}.
 */
export const ServiceConfigDecode = Schema.transformOrFail(ServiceConfigInput, ServiceConfig, {
  strict: false,
  decode: (input) => {
    const { working_dir, env_file, depends_on, ...rest } = input as Record<string, unknown>;
    const canonical: Record<string, unknown> = { ...rest };
    if (canonical.workingDirectory === undefined && working_dir !== undefined) {
      canonical.workingDirectory = working_dir;
    }
    if (canonical.envFile === undefined && env_file !== undefined) canonical.envFile = env_file;
    if (canonical.dependsOn === undefined && depends_on !== undefined) canonical.dependsOn = depends_on;
    return ParseResult.succeed(canonical);
  },
  encode: (encoded) => ParseResult.succeed(encoded),
});
export type ServiceConfigDecode = typeof ServiceConfigDecode.Type;

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

export const ToolingFlagShape = Schema.Struct({
  type: Schema.optional(Schema.Literal("boolean", "option")),
  description: Schema.optional(Schema.String),
  default: Schema.optional(ToolingVarLiteral),
  deprecated: Schema.optional(DeprecationNotice),
});
export type ToolingFlagShape = typeof ToolingFlagShape.Type;

export const ToolingArgShape = Schema.Struct({
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  default: Schema.optional(ToolingVarLiteral),
  deprecated: Schema.optional(DeprecationNotice),
});
export type ToolingArgShape = typeof ToolingArgShape.Type;

/**
 * ToolingTaskShape — Landofile `tooling.<name>` task entry accepted by this
 * schema.
 *
 * Accepted fields:
 * - `service:` — fixed service target (or `:host` / `:<flag-name>`).
 * - `description:` / `summary:` — short help text.
 * - `cmd:` — single command (string or string array).
 * - `cmds:` — sequential command list (strings only in this schema).
 * - `arguments: false` — reject caller-supplied positional arguments.
 * - `vars:` — accepted `ToolingVar` forms only.
 *
 * Supported deprecation metadata:
 * `deprecated:`, `flags.<name>.deprecated:`, and `args.<name>.deprecated:`.
 *
 * Unsupported fields rejected by `LandofileService` with remediation:
 * `deps:`, step-objects in `cmds:` (`task:`, `command:`, `defer:`,
 * `for:`, `cmd:` step overrides), `engine:`, `bootstrap:`, `dotenv:`,
 * `env:`, `user:`, `dir:`, `appMount:`, `stdio:`, `interactive:`,
 * `passThrough:`, `sources:`, `generates:`, `method:`, `status:`,
 * `preconditions:`, `if:`, `run:`, `platforms:`, `prompt:` (task-level),
 * `silent:`, `output:`, `failFast:`, `disabled:`, `aliases:`,
 * `topLevelAlias:`, `namespace:`, `internal:`, `hostProxyAllowed:`,
 * `examples:`, `usage:`.
 */
export const ToolingTaskShape = Schema.Struct({
  service: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  cmd: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
  cmds: Schema.optional(Schema.Array(Schema.String)),
  arguments: Schema.optional(Schema.Literal(false)).annotations({
    description: "Set to false to reject caller-supplied positional arguments for this task.",
  }),
  vars: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingVar })),
  deprecated: Schema.optional(DeprecationNotice),
  flags: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingFlagShape })),
  args: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingArgShape })),
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

export const SshAgentConfig = Schema.Struct({
  sidecar: Schema.optional(Schema.Literal(true)),
});
export type SshAgentConfig = typeof SshAgentConfig.Type;

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
  lando: Schema.optional(
    Schema.String.pipe(
      Schema.filter((range) => range.trim().length > 0 && validRange(range, { loose: false }) !== null, {
        message: () => 'lando must be a valid npm semver range such as ">=4.1 <5", "^4", or "4.x".',
      }),
    ),
  ).annotations({
    description:
      'Semver range the running Lando core version must satisfy before the app is planned or started (e.g. ">=4.1 <5"). Prereleases are included; unsatisfied constraints fail closed with remediation.',
  }),
  recipe: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderId),
  toolingEngine: Schema.optional(Schema.String),
  agentEnv: Schema.optional(Schema.Boolean),
  version: Schema.optional(Schema.String),
  includes: Schema.optional(Schema.Array(IncludeEntry)),
  include: Schema.optional(Schema.Array(Schema.String)),
  remotes: Schema.optional(Schema.Record({ key: Schema.String, value: RemoteConfig })),
  sync: Schema.optional(Schema.Record({ key: Schema.String, value: DatasetBinding })),
  volumes: Schema.optional(Schema.Record({ key: Schema.String, value: ComposeNamedResourceConfig })),
  networks: Schema.optional(Schema.Record({ key: Schema.String, value: ComposeNamedResourceConfig })),
  configs: Schema.optional(Schema.Record({ key: Schema.String, value: ComposeConfigConfig })),
  secrets: Schema.optional(Schema.Record({ key: Schema.String, value: ComposeSecretConfig })),
  sshAgent: Schema.optional(SshAgentConfig),
  services: Schema.optional(Schema.Record({ key: ServiceName, value: ServiceConfigDecode })),
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
