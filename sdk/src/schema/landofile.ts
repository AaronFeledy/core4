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
import { StringImportRef } from "./landofile-reference.ts";
import { LogSourceInput } from "./log-source.ts";
import { StorageScope } from "./mounts.ts";
import { CommandSpec, PortablePath, ProviderExtensionConfig, ProviderId, ServiceName } from "./primitives.ts";
import { RouterConfig } from "./proxy.ts";
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

const TOP_LEVEL_ENV_FILE_DESCRIPTION =
  "One or more app-root-relative env-file paths applied to every service below service-level envFile and environment overrides.";

const TopLevelEnvFileInput = Schema.transform(
  Schema.Union(Schema.String, Schema.Array(Schema.String)).annotations({
    description: TOP_LEVEL_ENV_FILE_DESCRIPTION,
  }),
  Schema.Array(Schema.String),
  {
    strict: true,
    decode: (input) => (typeof input === "string" ? [input] : input),
    encode: (paths) => paths,
  },
).annotations({ description: TOP_LEVEL_ENV_FILE_DESCRIPTION });

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

const COMPOSE_NETWORKS_DESCRIPTION =
  "Service network attachments as a name list or long mapping; canonicalized to a long mapping and carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.";

const ComposeNetworksInput = Schema.transform(
  Schema.Union(
    Schema.Array(Schema.String),
    Schema.Record({
      key: Schema.String,
      value: Schema.Union(ComposeNetworkAttachment, Schema.Null),
    }),
  ).annotations({ description: COMPOSE_NETWORKS_DESCRIPTION }),
  ComposeNetworkAttachmentRecord,
  {
    strict: true,
    decode: (input) =>
      Array.isArray(input)
        ? Object.fromEntries(input.map((name) => [name, {}]))
        : Object.fromEntries(Object.entries(input).map(([name, attachment]) => [name, attachment ?? {}])),
    encode: (attachments) => attachments,
  },
).annotations({ description: COMPOSE_NETWORKS_DESCRIPTION });

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

const composeConfigOrSecretInput = (description: string) =>
  Schema.transform(
    Schema.Array(Schema.Union(Schema.String, ComposeConfigOrSecretEntry)).annotations({ description }),
    Schema.Array(ComposeConfigOrSecretEntry),
    {
      strict: true,
      decode: (entries) => entries.map((entry) => (typeof entry === "string" ? { source: entry } : entry)),
      encode: (entries) => entries,
    },
  ).annotations({ description });

const COMPOSE_CONFIGS_DESCRIPTION =
  "Service config grants as source-name strings or long entries; canonicalized to long entries, carried losslessly into ServicePlan.extensions.compose, capability-checked, and realized as read-only file mounts honoring source, target, and mode.";

const COMPOSE_SECRETS_DESCRIPTION =
  "Service secret grants as source-name strings or long entries; canonicalized to long entries, carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.";

const SERVICE_CERTS_DESCRIPTION =
  "Leaf TLS certificate for this service: true issues one from the active certificate authority, false disables issuance, a path supplies a custom certificate, and an object supplies an explicit certificate and key. Separate from security.ca, which adds trusted certificate authorities.";

/** Certs input — leaf TLS toggle, custom certificate path, or explicit certificate and key pair. */
const CertsInput = Schema.Union(
  Schema.Boolean,
  Schema.String,
  Schema.Struct({
    cert: Schema.String.annotations({
      description: "Path to a custom leaf certificate for this service.",
    }),
    key: Schema.String.annotations({
      description: "Path to the private key matching the custom leaf certificate.",
    }),
  }),
).annotations({ description: SERVICE_CERTS_DESCRIPTION });

const SERVICE_SECURITY_DESCRIPTION =
  "Additional CA paths and per-service overrides for inheriting host network CA and proxy settings.";

const ServiceSecurityCaEntry = Schema.Union(Schema.String, StringImportRef).annotations({
  jsonSchema: { acceptsImportRef: true },
});

const ServiceSecurity = Schema.Struct({
  ca: Schema.optional(Schema.Array(ServiceSecurityCaEntry)).annotations({
    description: "Additional CA certificate paths for this service.",
  }),
  inheritNetworkCa: Schema.optional(Schema.Boolean).annotations({
    description: "Override whether this service inherits host network CA certificates.",
  }),
  inheritNetworkProxy: Schema.optional(Schema.Boolean).annotations({
    description: "Override whether this service inherits host network proxy settings.",
  }),
});

const ServiceSecurityCaAlias = Schema.Union(ServiceSecurityCaEntry, Schema.Array(ServiceSecurityCaEntry));
const Forbidden = Schema.optional(Schema.Never);

const ServiceSecurityInput = Schema.Union(
  Schema.Struct({
    ca: Schema.optional(Schema.Array(ServiceSecurityCaEntry)),
    cas: Forbidden,
    "certificate-authority": Forbidden,
    "certificate-authorities": Forbidden,
    inheritNetworkCa: Schema.optional(Schema.Boolean),
    inheritNetworkProxy: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ca: Forbidden,
    cas: ServiceSecurityCaAlias,
    "certificate-authority": Forbidden,
    "certificate-authorities": Forbidden,
    inheritNetworkCa: Schema.optional(Schema.Boolean),
    inheritNetworkProxy: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ca: Forbidden,
    cas: Forbidden,
    "certificate-authority": ServiceSecurityCaAlias,
    "certificate-authorities": Forbidden,
    inheritNetworkCa: Schema.optional(Schema.Boolean),
    inheritNetworkProxy: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ca: Forbidden,
    cas: Forbidden,
    "certificate-authority": Forbidden,
    "certificate-authorities": ServiceSecurityCaAlias,
    inheritNetworkCa: Schema.optional(Schema.Boolean),
    inheritNetworkProxy: Schema.optional(Schema.Boolean),
  }),
).annotations({ description: SERVICE_SECURITY_DESCRIPTION });

const ServiceSecurityField = Schema.transform(ServiceSecurityInput, ServiceSecurity, {
  strict: true,
  decode: (input) => {
    const {
      ca,
      cas,
      "certificate-authority": certificateAuthority,
      "certificate-authorities": certificateAuthorities,
      inheritNetworkCa,
      inheritNetworkProxy,
    } = input;
    const authoredCa = ca ?? cas ?? certificateAuthority ?? certificateAuthorities;
    return {
      ...(authoredCa === undefined ? {} : { ca: Array.isArray(authoredCa) ? authoredCa : [authoredCa] }),
      ...(inheritNetworkCa === undefined ? {} : { inheritNetworkCa }),
      ...(inheritNetworkProxy === undefined ? {} : { inheritNetworkProxy }),
    };
  },
  encode: (security) => security,
}).annotations({ description: SERVICE_SECURITY_DESCRIPTION });

/**
 * Login credentials a catalog service may author under `services.<name>.creds`.
 */
export const ServiceCreds = Schema.Struct({
  user: Schema.String.annotations({
    description: "Username created or used by the service.",
  }),
  password: Schema.String.annotations({
    description: "Password for the service user.",
  }),
  database: Schema.String.annotations({
    description: "Database name the service user can access.",
  }),
  rootPassword: Schema.optional(Schema.String).annotations({
    description: "Optional administrative password distinct from the service user password.",
  }),
}).annotations({
  identifier: "ServiceCreds",
  title: "Service Creds",
  description: "Username, password, and database credentials for a catalog service.",
});
export type ServiceCreds = typeof ServiceCreds.Type;

/**
 * ServiceConfig — what a user authors under `services.<name>:` in a Landofile.
 * Covers the fields consumed by downstream provider logic.
 */
const ServiceConfigWithExtensions = Schema.Struct(
  {
    api: Schema.optional(Schema.Literal(4)),
    type: Schema.optional(Schema.String), // defaults to "lando"
    primary: Schema.optional(Schema.Boolean),

    image: Schema.optional(Schema.String).annotations({
      description: "Container image reference used by the service.",
    }),
    build: Schema.optional(BuildBlock),
    command: Schema.optional(CommandSpec).annotations({
      description: "Command executed when the service starts.",
    }),
    entrypoint: Schema.optional(CommandSpec).annotations({
      description: "Entrypoint used to launch the service container.",
    }),
    user: Schema.optional(Schema.String).annotations({
      description: "Container user used to run service processes.",
    }),
    workingDirectory: Schema.optional(PortablePath).annotations({
      description: "Container working directory for service processes.",
    }),
    database: Schema.optional(Schema.String).annotations({
      description: "Default database, bucket, or equivalent data namespace created for the service.",
    }),
    creds: Schema.optional(ServiceCreds).annotations({
      description: "Service login credentials used to provision or connect to the service.",
    }),
    hosts: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))).annotations({
      description: "Database hosts this admin UI connects to; a single hostname or a list of hostnames.",
    }),
    cores: Schema.optional(Schema.Array(Schema.String)),
    port: Schema.optional(Schema.Number).annotations({
      description: "Primary container port exposed by the service.",
    }),
    framework: Schema.optional(Schema.String),
    webroot: Schema.optional(PortablePath).annotations({
      description: "Container path served as this service's HTTP document root.",
    }),
    backend: Schema.optional(Schema.String).annotations({
      description: "Name of the app service this cache or proxy fronts.",
    }),
    allowOverride: Schema.optional(Schema.Boolean).annotations({
      description: "Whether an Apache-backed service enables .htaccess overrides for its webroot.",
    }),
    composer: Schema.optional(Schema.Union(Schema.Literal(false), Schema.String)).annotations({
      description:
        "PHP Composer selection: a major channel, an exact checksum-pinned version, or false to skip install.",
    }),
    via: Schema.optional(Schema.String).annotations({
      description: 'PHP serving mode: "apache" (default), "fpm", or "cli".',
    }),
    xdebug: Schema.optional(Schema.Union(Schema.Boolean, Schema.String)).annotations({
      description:
        'PHP Xdebug selection: true installs with mode "debug", a comma-separated Xdebug 3 mode string, or false to skip install.',
    }),
    db_client: Schema.optional(
      Schema.Union(Schema.Literal("auto"), Schema.Literal(false), Schema.String),
    ).annotations({
      description:
        'PHP database client selection: "auto" detects database service families, false installs none, or "<family>:<version>" forces one client.',
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
      description: COMPOSE_NETWORKS_DESCRIPTION,
    }),
    configs: Schema.optional(composeConfigOrSecretInput(COMPOSE_CONFIGS_DESCRIPTION)).annotations({
      description: COMPOSE_CONFIGS_DESCRIPTION,
    }),
    secrets: Schema.optional(composeConfigOrSecretInput(COMPOSE_SECRETS_DESCRIPTION)).annotations({
      description: COMPOSE_SECRETS_DESCRIPTION,
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
    ).annotations({
      description: "Application source mount configuration, or false to disable the app mount.",
    }),
    mounts: Schema.optional(Schema.Array(MountInput)).annotations({
      description: "Additional host or managed-file mounts attached to the service.",
    }),
    storage: Schema.optional(Schema.Array(StorageInput)).annotations({
      description: "Persistent or cached storage attached to the service.",
    }),

    endpoints: Schema.optional(Schema.Array(EndpointInput)).annotations({
      description: "Internal or published network endpoints exposed by the service.",
    }),
    routes: Schema.optional(Schema.Array(RouteInput)).annotations({
      description: "Hostnames routed to service endpoints.",
    }),

    healthcheck: Schema.optional(HealthcheckField).annotations({
      description:
        "Healthcheck as canonical Lando fields or Compose test, disable, and duration spellings; canonicalized to the Lando healthcheck model while preserving start_interval losslessly.",
    }),
    logs: Schema.optional(Schema.Array(LogSourceInput)),
    certs: Schema.optional(CertsInput).annotations({ description: SERVICE_CERTS_DESCRIPTION }),
    hostnames: Schema.optional(Schema.Array(Schema.String)),
    security: Schema.optional(ServiceSecurityField).annotations({
      description: SERVICE_SECURITY_DESCRIPTION,
    }),
    dependsOn: Schema.optional(ComposeDependsOnInput),

    providers: Schema.optional(ProviderExtensionConfig).annotations({
      description: "Provider-specific service configuration keyed by provider id.",
    }),
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
 * `depends_on`) and service security CA aliases. Used as the decode boundary
 * for `services.<name>:`.
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
    "Accepted Landofile service authoring surface with canonical keys, Compose cross-key aliases, and service security CA aliases.",
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

const ToolingEnvironment = Schema.Record({ key: Schema.String, value: ToolingVarLiteral }).annotations({
  description: "Environment variables supplied to a tooling task as scalar values.",
});

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

export const AppLifecycleEventName = Schema.Literal(
  "pre-init",
  "post-init",
  "pre-start",
  "post-start",
  "pre-stop",
  "post-stop",
  "pre-rebuild",
  "post-rebuild",
  "pre-destroy",
  "post-destroy",
).annotations({ description: "App lifecycle point that runs an ordered Landofile event step list." });
export type AppLifecycleEventName = typeof AppLifecycleEventName.Type;

const EventStepCondition = Schema.Union(Schema.String, Schema.Boolean);

/**
 * Scalar literal or homogeneous scalar array for a canonical `command:` flag/arg.
 * Arrays support `multiple` inputs; mixed types and objects fail closed.
 */
export const EventCommandInputValue = Schema.Union(
  ToolingVarLiteral,
  Schema.Array(Schema.String),
  Schema.Array(Schema.Number),
  Schema.Array(Schema.Boolean),
);
export type EventCommandInputValue = typeof EventCommandInputValue.Type;

export const EventCommandStep = Schema.Struct({
  cmd: Schema.optional(Schema.Never),
  task: Schema.optional(Schema.Never),
  command: Schema.String,
  defer: Schema.optional(Schema.Never),
  for: Schema.optional(Schema.Never),
  flags: Schema.optional(Schema.Record({ key: Schema.String, value: EventCommandInputValue })),
  args: Schema.optional(Schema.Record({ key: Schema.String, value: EventCommandInputValue })),
  raw: Schema.optional(Schema.Array(Schema.String)),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
}).annotations({
  identifier: "EventCommandStep",
  description: "Direct invocation of a canonical Lando command.",
});
export type EventCommandStep = typeof EventCommandStep.Type;

export const EventTaskStep = Schema.Struct({
  cmd: Schema.optional(Schema.Never),
  task: Schema.String,
  command: Schema.optional(Schema.Never),
  defer: Schema.optional(Schema.Never),
  for: Schema.optional(Schema.Never),
  vars: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingVarLiteral })),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
}).annotations({
  identifier: "EventTaskStep",
  description: "Invocation of an effective Landofile tooling task.",
});
export type EventTaskStep = typeof EventTaskStep.Type;

export const EventCmdStep = Schema.Struct({
  cmd: Schema.String,
  task: Schema.optional(Schema.Never),
  command: Schema.optional(Schema.Never),
  defer: Schema.optional(Schema.Never),
  for: Schema.optional(Schema.Never),
  service: Schema.optional(Schema.String),
  dir: Schema.optional(PortablePath),
  env: Schema.optional(ToolingEnvironment),
  user: Schema.optional(Schema.String),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
}).annotations({
  identifier: "EventCmdStep",
  description: "Provider tooling command with optional service targeting.",
});
export type EventCmdStep = typeof EventCmdStep.Type;

const EventForVarSelector = Schema.Struct({
  var: Schema.String,
  matrix: Schema.optional(Schema.Never),
  sources: Schema.optional(Schema.Never),
  generates: Schema.optional(Schema.Never),
});

const EventForMatrixSelector = Schema.Struct({
  var: Schema.optional(Schema.Never),
  matrix: Schema.Record({ key: Schema.String, value: Schema.Array(ToolingVarLiteral) }),
  sources: Schema.optional(Schema.Never),
  generates: Schema.optional(Schema.Never),
});

const EventForSourcesSelector = Schema.Struct({
  var: Schema.optional(Schema.Never),
  matrix: Schema.optional(Schema.Never),
  sources: Schema.Literal(true),
  generates: Schema.optional(Schema.Never),
});

const EventForGeneratesSelector = Schema.Struct({
  var: Schema.optional(Schema.Never),
  matrix: Schema.optional(Schema.Never),
  sources: Schema.optional(Schema.Never),
  generates: Schema.Literal(true),
});

export const EventForSelector = Schema.Union(
  Schema.Array(ToolingVarLiteral),
  EventForVarSelector,
  EventForMatrixSelector,
  EventForSourcesSelector,
  EventForGeneratesSelector,
).annotations({
  identifier: "EventForSelector",
  description: "Literal or task-derived values selected for an event step loop.",
});
export type EventForSelector = typeof EventForSelector.Type;

const EventDeferredCmdShorthand = Schema.Struct({
  cmd: Schema.optional(Schema.Never),
  task: Schema.optional(Schema.Never),
  command: Schema.optional(Schema.Never),
  defer: Schema.String,
  for: Schema.optional(Schema.Never),
  service: Schema.optional(Schema.String),
  dir: Schema.optional(PortablePath),
  env: Schema.optional(ToolingEnvironment),
  user: Schema.optional(Schema.String),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
});

const EventDeferredCmdStep = Schema.Struct({
  cmd: Schema.String,
  task: Schema.optional(Schema.Never),
  command: Schema.optional(Schema.Never),
  defer: Schema.Literal(true),
  for: Schema.optional(Schema.Never),
  service: Schema.optional(Schema.String),
  dir: Schema.optional(PortablePath),
  env: Schema.optional(ToolingEnvironment),
  user: Schema.optional(Schema.String),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
});

const EventDeferredTaskStep = Schema.Struct({
  cmd: Schema.optional(Schema.Never),
  task: Schema.String,
  command: Schema.optional(Schema.Never),
  defer: Schema.Literal(true),
  for: Schema.optional(Schema.Never),
  vars: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingVarLiteral })),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
});

const EventDeferredCommandStep = Schema.Struct({
  cmd: Schema.optional(Schema.Never),
  task: Schema.optional(Schema.Never),
  command: Schema.String,
  defer: Schema.Literal(true),
  for: Schema.optional(Schema.Never),
  flags: Schema.optional(Schema.Record({ key: Schema.String, value: EventCommandInputValue })),
  args: Schema.optional(Schema.Record({ key: Schema.String, value: EventCommandInputValue })),
  raw: Schema.optional(Schema.Array(Schema.String)),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
});

export const EventDeferStep = Schema.Union(
  EventDeferredCmdShorthand,
  EventDeferredCmdStep,
  EventDeferredTaskStep,
  EventDeferredCommandStep,
).annotations({
  identifier: "EventDeferStep",
  description: "An event action registered for LIFO finalization.",
});
export type EventDeferStep = typeof EventDeferStep.Type;

const EventForCmdStep = Schema.Struct({
  cmd: Schema.String,
  task: Schema.optional(Schema.Never),
  command: Schema.optional(Schema.Never),
  defer: Schema.optional(Schema.Never),
  for: EventForSelector,
  service: Schema.optional(Schema.String),
  dir: Schema.optional(PortablePath),
  env: Schema.optional(ToolingEnvironment),
  user: Schema.optional(Schema.String),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
});

const EventForTaskStep = Schema.Struct({
  cmd: Schema.optional(Schema.Never),
  task: Schema.String,
  command: Schema.optional(Schema.Never),
  defer: Schema.optional(Schema.Never),
  for: EventForSelector,
  vars: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingVarLiteral })),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
});

const EventForCommandStep = Schema.Struct({
  cmd: Schema.optional(Schema.Never),
  task: Schema.optional(Schema.Never),
  command: Schema.String,
  defer: Schema.optional(Schema.Never),
  for: EventForSelector,
  flags: Schema.optional(Schema.Record({ key: Schema.String, value: EventCommandInputValue })),
  args: Schema.optional(Schema.Record({ key: Schema.String, value: EventCommandInputValue })),
  raw: Schema.optional(Schema.Array(Schema.String)),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
});

const EventForDeferredCmdStep = Schema.Struct({
  cmd: Schema.optional(Schema.Never),
  task: Schema.optional(Schema.Never),
  command: Schema.optional(Schema.Never),
  defer: Schema.String,
  for: EventForSelector,
  service: Schema.optional(Schema.String),
  dir: Schema.optional(PortablePath),
  env: Schema.optional(ToolingEnvironment),
  user: Schema.optional(Schema.String),
  ignoreError: Schema.optional(Schema.Boolean),
  if: Schema.optional(EventStepCondition),
  silent: Schema.optional(Schema.Boolean),
});

export const EventForStep = Schema.Union(
  EventForCmdStep,
  EventForTaskStep,
  EventForCommandStep,
  EventForDeferredCmdStep,
).annotations({
  identifier: "EventForStep",
  description: "An event action repeated for each selected value.",
});
export type EventForStep = typeof EventForStep.Type;

export const EventStep = Schema.Union(
  Schema.String,
  EventCmdStep,
  EventTaskStep,
  EventCommandStep,
  EventDeferStep,
  EventForStep,
).annotations({
  identifier: "EventStep",
  description: "One ordered events-as-tasks step.",
});
export type EventStep = typeof EventStep.Type;

export const LandofileEvents = Schema.Struct({
  "pre-init": Schema.optional(Schema.Array(EventStep)),
  "post-init": Schema.optional(Schema.Array(EventStep)),
  "pre-start": Schema.optional(Schema.Array(EventStep)),
  "post-start": Schema.optional(Schema.Array(EventStep)),
  "pre-stop": Schema.optional(Schema.Array(EventStep)),
  "post-stop": Schema.optional(Schema.Array(EventStep)),
  "pre-rebuild": Schema.optional(Schema.Array(EventStep)),
  "post-rebuild": Schema.optional(Schema.Array(EventStep)),
  "pre-destroy": Schema.optional(Schema.Array(EventStep)),
  "post-destroy": Schema.optional(Schema.Array(EventStep)),
}).annotations({
  identifier: "LandofileEvents",
  description: "Ordered tasks keyed by app lifecycle event name.",
});
export type LandofileEvents = typeof LandofileEvents.Type;

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
 * - `dir:` — task working directory.
 * - `env:` — task environment overrides.
 * - `vars:` — accepted `ToolingVar` forms only.
 *
 * Supported deprecation metadata:
 * `deprecated:`, `flags.<name>.deprecated:`, and `args.<name>.deprecated:`.
 *
 * Unsupported fields rejected by `LandofileService` with remediation:
 * `deps:`, step-objects in `cmds:` (`task:`, `command:`, `defer:`,
 * `for:`, `cmd:` step overrides), `engine:`, `bootstrap:`, `dotenv:`,
 * `user:`, `appMount:`, `stdio:`, `interactive:`,
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
  dir: Schema.optional(PortablePath).annotations({
    description: "Working directory used when the tooling task runs.",
  }),
  env: Schema.optional(ToolingEnvironment).annotations({
    description: "Environment variables applied to this tooling task after app-wide tooling defaults.",
  }),
  vars: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingVar })),
  deprecated: Schema.optional(DeprecationNotice),
  flags: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingFlagShape })),
  args: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingArgShape })),
});
export type ToolingTaskShape = typeof ToolingTaskShape.Type;

/** App-wide defaults inherited by tooling tasks unless a task overrides them. */
export const ToolingDefaultsShape = Schema.Struct({
  service: Schema.optional(Schema.String).annotations({
    description: "Default service target inherited by tooling tasks.",
  }),
  dir: Schema.optional(PortablePath).annotations({
    description: "Default working directory inherited by tooling tasks.",
  }),
  env: Schema.optional(ToolingEnvironment).annotations({
    description: "Default environment variables inherited by tooling tasks.",
  }),
  vars: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingVar })).annotations({
    description: "Default tooling variables inherited by tooling tasks.",
  }),
});
export type ToolingDefaultsShape = typeof ToolingDefaultsShape.Type;

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

/**
 * ToolingIncludeShape — one entry of the `toolingIncludes:` shorthand map.
 * The map key is the include namespace; the entry names a local tooling
 * fragment carrying only `tooling:` and `toolingIncludes:`.
 *
 * Deliberately omitted: `dir:` (task-level `dir:` is rejected) and
 * `checksum:` (tooling fragments are local-file only, so there is no remote
 * source to pin).
 */
export const ToolingIncludeShape = Schema.Struct({
  file: Schema.String.annotations({
    description:
      "Path to the tooling fragment, resolved relative to the file that declares the include and contained under the app root.",
  }),
  optional: Schema.optional(Schema.Boolean).annotations({
    description: "When true, a missing fragment file is skipped instead of failing the load.",
  }),
  flatten: Schema.optional(Schema.Boolean).annotations({
    description: "When true, included task names register unprefixed instead of under the include namespace.",
  }),
  internal: Schema.optional(Schema.Boolean).annotations({
    description: "When true, every task contributed by this include is registered hidden.",
  }),
  aliases: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Additional namespaces the included tasks also register under.",
  }),
  excludes: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Fragment task names dropped before flattening or namespace registration.",
  }),
  vars: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingVarLiteral })).annotations({
    description: "Literal vars applied to every included task unless the task defines its own value.",
  }),
});
export type ToolingIncludeShape = typeof ToolingIncludeShape.Type;

export const IncludeEntry = Schema.Union(
  Schema.String,
  Schema.Struct({
    source: Schema.String,
    kind: Schema.optional(Schema.Literal("landofile", "compose", "tooling")).annotations({
      description:
        'The fragment content semantics: "landofile" is a Landofile fragment; "compose" is a Compose fragment routed through the same parser, rejection, and decode path; "tooling" is a tooling fragment carrying only tooling: and toolingIncludes:. This is not source transport.',
    }),
    path: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
    checksum: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String).annotations({
      description:
        'kind: "tooling" only — the sub-namespace included tasks register under. Required unless flatten is true.',
    }),
    flatten: Schema.optional(Schema.Boolean).annotations({
      description:
        'kind: "tooling" only — when true, included task names register unprefixed instead of under the include namespace.',
    }),
    internal: Schema.optional(Schema.Boolean).annotations({
      description: 'kind: "tooling" only — when true, every task contributed by this include is hidden.',
    }),
    optional: Schema.optional(Schema.Boolean).annotations({
      description: 'kind: "tooling" only — when true, a missing fragment file is skipped instead of failing.',
    }),
    aliases: Schema.optional(Schema.Array(Schema.String)).annotations({
      description: 'kind: "tooling" only — additional namespaces the included tasks also register under.',
    }),
    excludes: Schema.optional(Schema.Array(Schema.String)).annotations({
      description:
        'kind: "tooling" only — fragment task names dropped before flattening or namespace registration.',
    }),
    vars: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingVarLiteral })).annotations({
      description:
        'kind: "tooling" only — literal vars applied to every included task unless the task defines its own value.',
    }),
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
  "name",
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

export const CommandAliasesShape = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotations({
    description: "Whether top-level command aliases are enabled for this app. Defaults to true.",
  }),
  disabled: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Top-level alias tokens disabled for this app; canonical command ids remain callable.",
  }),
  custom: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })).annotations({
    description: "App-specific top-level alias tokens mapped to canonical command ids.",
  }),
}).annotations({ identifier: "CommandAliasesShape", title: "Command Aliases" });
export type CommandAliasesShape = typeof CommandAliasesShape.Type;

/**
 * LandofileShape — the authored Landofile shape.
 * Excludes fields not modeled here: keys:, plugins:, pluginDirs:.
 */
const LandofileShapeBase = Schema.Struct({
  name: Schema.optional(
    Schema.String.annotations({
      description:
        "User-facing app name. Runtime identity is a lowercase ASCII slug: non-alphanumeric runs become one hyphen, edge hyphens are removed, and the result is capped at 57 characters so the lando-<slug> network label stays within DNS's 63-character limit. Names with no ASCII alphanumeric characters use a stable app-root hash.",
    }),
  ),
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
  commandAliases: Schema.optional(CommandAliasesShape).annotations({
    description: "Per-app top-level command alias remapping and disablement policy.",
  }),
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
  env_file: Schema.optional(TopLevelEnvFileInput),
  sshAgent: Schema.optional(SshAgentConfig),
  services: Schema.optional(Schema.Record({ key: ServiceName, value: ServiceConfigDecode })),
  proxy: Schema.optional(Schema.Record({ key: ServiceName, value: Schema.Array(RouteInput) })),
  router: Schema.optional(RouterConfig).annotations({
    description: "App-authored shared-router bind address and port policy.",
  }),
  providers: Schema.optional(ProviderExtensionConfig),
  toolingDefaults: Schema.optional(ToolingDefaultsShape).annotations({
    description: "App-wide service, directory, environment, and variable defaults for tooling tasks.",
  }),
  tooling: Schema.optional(Schema.Record({ key: Schema.String, value: ToolingTaskShape })),
  events: Schema.optional(LandofileEvents),
  toolingIncludes: Schema.optional(
    Schema.Record({ key: Schema.String, value: ToolingIncludeShape }),
  ).annotations({
    description:
      "Shorthand map of tooling-fragment includes keyed by include namespace; equivalent to includes: entries with kind: tooling.",
  }),
});

export const LandofileShape = Schema.asSchema(
  LandofileShapeBase.pipe(
    Schema.extend(Schema.Record({ key: Schema.TemplateLiteral("x-", Schema.String), value: Schema.Unknown })),
  ),
);
export type LandofileShape = typeof LandofileShape.Type;

export const defineLandofile = <T extends LandofileShape>(value: T): T => value;
