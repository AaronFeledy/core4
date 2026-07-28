import { ParseResult, Schema } from "effect";
import type * as AST from "effect/SchemaAST";
import validRange from "semver/ranges/valid.js";

import { BuildBlock } from "./build-block.ts";
import { HealthcheckCanonicalBase, HealthcheckField } from "./compose-healthcheck.ts";
import { ComposeExposeField, ComposePortsField } from "./compose-ports.ts";
import { ComposeServiceKnobFields } from "./compose-service-knobs.ts";
import { ComposeVolumesField } from "./compose-volumes.ts";
import { DeprecationNotice } from "./deprecation.ts";
import { EndpointInput } from "./endpoint.ts";
import { LogSourceInput } from "./log-source.ts";
import { StorageScope } from "./mounts.ts";
import { CommandSpec, PortablePath, ProviderExtensionConfig, ProviderId, ServiceName } from "./primitives.ts";
import { DatasetBinding, RemoteConfig } from "./remote-sync.ts";
import { ServiceDependencyCondition as ServiceDependencyConditionSchema } from "./service-dependency.ts";

// Landofile input shape — what a user authors (services:, routes:, etc.).

export { EndpointInput } from "./endpoint.ts";
export { BuildBlock } from "./build-block.ts";
export { ServiceDependencyCondition } from "./service-dependency.ts";

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

/** Canonical Lando healthcheck schema; Compose-capable authoring is accepted by `ServiceConfig`. */
export const HealthcheckInput = HealthcheckCanonicalBase;
export type HealthcheckInput = typeof HealthcheckInput.Type;

export const ServiceDependency = Schema.Struct({
  service: Schema.String,
  condition: Schema.optional(ServiceDependencyConditionSchema),
  required: Schema.optional(Schema.Boolean),
  restart: Schema.optional(Schema.Boolean),
}).annotations({
  identifier: "ServiceDependency",
  title: "Service Dependency",
  description:
    "A single inter-service dependency with its optional Compose condition, required, and restart flags.",
});
export type ServiceDependency = typeof ServiceDependency.Type;

const ServiceDependencyInput = Schema.Struct({
  condition: ServiceDependencyConditionSchema,
  required: Schema.optional(Schema.Boolean),
  restart: Schema.optional(Schema.Boolean),
});

const RESERVED_KEY_PROPERTY_NAMES = { not: { const: "__proto__" } } as const;

const ReservedComposeScalarMapInput = Schema.Unknown.annotations({
  jsonSchema: {
    type: "object",
    propertyNames: RESERVED_KEY_PROPERTY_NAMES,
    additionalProperties: {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
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
const ComposeScalarRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean, Schema.Null),
});

const ServiceDependencyInputRecord = Schema.transformOrFail(
  ReservedDependencyMapInput,
  Schema.Record({ key: Schema.String, value: ServiceDependencyInput }),
  {
    strict: false,
    decode: (input, _options, ast) => decodeReservedKeyMap(input, ast),
    encode: (record) => ParseResult.succeed(record),
  },
);

const ComposeScalarMapInput = Schema.transformOrFail(ReservedComposeScalarMapInput, ComposeScalarRecord, {
  strict: false,
  decode: (input, _options, ast) => decodeReservedKeyMap(input, ast),
  encode: (record) => ParseResult.succeed(record),
});

const ComposeEnvironmentInput = Schema.transformOrFail(
  Schema.Union(ComposeScalarMapInput, Schema.Array(Schema.String)),
  StringRecord,
  {
    strict: true,
    decode: (input, _options, ast) => {
      if (!Array.isArray(input)) {
        const entries = Object.entries(input);
        const unresolved = entries.find(([, value]) => value === null);
        if (unresolved !== undefined) {
          return ParseResult.fail(
            new ParseResult.Type(
              ast,
              input,
              `Landofile service environment entry "${unresolved[0]}" has no value; host-environment interpolation is unsupported in Landofiles — provide a concrete value.`,
            ),
          );
        }
        return ParseResult.succeed(Object.fromEntries(entries.map(([key, value]) => [key, String(value)])));
      }
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
    "Service environment variables as a map (KEY: value) or a Compose-style KEY=value list. A bare list entry or null map value is rejected because Landofiles do not read host environment variables.",
});

const ComposeLabelsInput = Schema.transformOrFail(
  Schema.Union(ComposeScalarMapInput, Schema.Array(Schema.String)),
  StringRecord,
  {
    strict: true,
    decode: (input, _options, ast) => {
      if (!Array.isArray(input)) {
        return ParseResult.succeed(
          Object.fromEntries(
            Object.entries(input).map(([key, value]) => [key, value === null ? "" : String(value)]),
          ),
        );
      }
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
  description:
    "Service labels as a map or a Compose-style KEY=value list; canonicalized to a map, with null and bare entries becoming empty strings.",
});

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

const ExtensionRecord = Schema.Record({
  key: Schema.TemplateLiteral("x-", Schema.String),
  value: Schema.Unknown,
}).annotations({
  description:
    "preserved losslessly; never interpreted by Lando or the provider; implies no vendor-specific behavior.",
});

const ComposeNetworkAttachment = Schema.Struct(
  {
    aliases: Schema.optional(Schema.Array(Schema.String)),
    interface_name: Schema.optional(Schema.String),
    ipv4_address: Schema.optional(Schema.String),
    ipv6_address: Schema.optional(Schema.String),
    link_local_ips: Schema.optional(Schema.Array(Schema.String)),
    mac_address: Schema.optional(Schema.String),
    driver_opts: Schema.optional(
      Schema.Record({
        key: Schema.String,
        value: Schema.Union(Schema.String, Schema.Number),
      }),
    ),
    priority: Schema.optional(Schema.Number),
    gw_priority: Schema.optional(Schema.Number),
  },
  ExtensionRecord,
);

const ComposeNetworkAttachmentRecord = Schema.Record({
  key: Schema.String,
  value: ComposeNetworkAttachment,
});

const ComposeNetworksInput = Schema.transform(
  Schema.Union(
    Schema.Array(Schema.String),
    Schema.Record({
      key: Schema.String,
      value: Schema.Union(ComposeNetworkAttachment, Schema.Null),
    }),
  ),
  ComposeNetworkAttachmentRecord,
  {
    strict: true,
    decode: (input) =>
      Array.isArray(input)
        ? Object.fromEntries(input.map((name) => [name, {}]))
        : Object.fromEntries(Object.entries(input).map(([name, attachment]) => [name, attachment ?? {}])),
    encode: (attachments) => attachments,
  },
).annotations({
  description:
    "Service network attachments as a name list or long mapping; canonicalized to a long mapping and carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.",
});

const ComposeConfigOrSecretEntry = Schema.Struct(
  {
    source: Schema.optional(Schema.String),
    target: Schema.optional(Schema.String),
    uid: Schema.optional(Schema.String),
    gid: Schema.optional(Schema.String),
    mode: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
  },
  ExtensionRecord,
);

const ComposeConfigOrSecretInput = Schema.transform(
  Schema.Array(Schema.Union(Schema.String, ComposeConfigOrSecretEntry)),
  Schema.Array(ComposeConfigOrSecretEntry),
  {
    strict: true,
    decode: (entries) => entries.map((entry) => (typeof entry === "string" ? { source: entry } : entry)),
    encode: (entries) => entries,
  },
);

/**
 * ServiceConfig — what a user authors under `services.<name>:` in a Landofile.
 * Covers the fields consumed by downstream provider logic.
 */
const ServiceConfigWithExtensions = Schema.Struct(
  {
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
      description:
        "Service labels as a map or a Compose-style KEY=value list; canonicalized to a map, with null and bare entries becoming empty strings.",
    }),

    ...ComposeServiceKnobFields,

    ports: Schema.optional(ComposePortsField).annotations({
      description:
        'Published container ports as Compose short strings ("8080:80", "127.0.0.1:8080:80/udp", "80", ranges) or long objects; canonicalized to target/published/hostIp/protocol entries that normalize into endpoints.',
    }),
    expose: Schema.optional(ComposeExposeField).annotations({
      description:
        "Container-only ports exposed to other services as strings, numbers, or ranges; never host-published, and normalized into internal endpoints.",
    }),
    volumes: Schema.optional(ComposeVolumesField).annotations({
      description:
        'Compose volumes as short strings ("./src:/app", "named:/data:ro", "/data") or long objects; host paths normalize into mounts, named and anonymous volumes into storage, and tmpfs into the preserved tmpfs runtime knob.',
    }),
    networks: Schema.optional(ComposeNetworksInput).annotations({
      description:
        "Service network attachments canonicalized to a long mapping; carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.",
    }),
    configs: Schema.optional(ComposeConfigOrSecretInput).annotations({
      description:
        "Service config grants canonicalized to long entries; carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.",
    }),
    secrets: Schema.optional(ComposeConfigOrSecretInput).annotations({
      description:
        "Service secret grants canonicalized to long entries; carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.",
    }),
    profiles: Schema.optional(Schema.Array(Schema.String)).annotations({
      description:
        "Compose profile names; carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.",
    }),

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

    healthcheck: Schema.optional(HealthcheckField).annotations({
      description:
        "Healthcheck as canonical Lando fields or Compose test, disable, and duration spellings; canonicalized to the Lando healthcheck model while preserving start_interval losslessly.",
    }),
    logs: Schema.optional(Schema.Array(LogSourceInput)),
    hostnames: Schema.optional(Schema.Array(Schema.String)),
    dependsOn: Schema.optional(ComposeDependsOnInput),

    providers: Schema.optional(ProviderExtensionConfig),
  },
  ExtensionRecord,
);

export const ServiceConfig = Object.assign(ServiceConfigWithExtensions, {
  pick: Schema.Struct(ServiceConfigWithExtensions.fields).pick,
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
const ServiceConfigDecode = Schema.transformOrFail(ServiceConfigInput, ServiceConfig, {
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
    kind: Schema.optional(Schema.Literal("landofile", "compose")).annotations({
      description:
        'The fragment content semantics: "landofile" is a Landofile fragment; "compose" is a Compose fragment routed through the same parser, rejection, and decode path. This is not source transport.',
    }),
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

const ComposeNamedNetworkConfig = Schema.transform(
  Schema.Union(ComposeNamedResourceConfig, Schema.Null),
  ComposeNamedResourceConfig,
  {
    strict: true,
    decode: (config) => config ?? {},
    encode: (config) => config,
  },
);

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
  networks: Schema.optional(Schema.Record({ key: Schema.String, value: ComposeNamedNetworkConfig })),
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
