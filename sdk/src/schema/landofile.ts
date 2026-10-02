import { SchemaIssue } from "effect";
import { Effect, SchemaTransformation } from "effect";
import { Schema } from "effect";
import validRange from "semver/ranges/valid.js";

import { GpgAgentConfig, SshAgentConfig } from "./agent-forwarding.ts";
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
import { ScannerConfig } from "./networking.ts";
import {
  AbsoluteContainerPath,
  CommandSpec,
  PortablePath,
  ProviderExtensionConfig,
  ProviderId,
  ServiceName,
} from "./primitives.ts";
import { RouterConfig } from "./proxy.ts";
import { LandofileRecipeField } from "./recipe-provenance.ts";
import { DatasetBinding, RemoteConfig } from "./remote-sync.ts";
import { RouteFilter } from "./route-filter.ts";
import { ServiceDependencyCondition as ServiceDependencyConditionSchema } from "./service-dependency.ts";

// Landofile input shape — what a user authors (services:, routes:, etc.).

export { EndpointInput } from "./endpoint.ts";
export { BuildBlock } from "./build-block.ts";
export { ServiceDependencyCondition } from "./service-dependency.ts";

/** Route input as authored under `services.<name>.routes` (or top-level `proxy:`). */
export const RouteObjectInput = Schema.Struct({
  hostname: Schema.String.annotate({ description: "Host header pattern for this route." }),
  scheme: Schema.optionalKey(Schema.Literals(["http", "https", "both"])).annotate({
    description: "HTTP or HTTPS schemes served by this route.",
  }),
  endpoint: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])).annotate({
    description: "Target service endpoint name or port.",
  }),
  pathPrefix: Schema.optionalKey(Schema.String).annotate({ description: "Request path prefix to match." }),
  filters: Schema.optionalKey(Schema.Array(RouteFilter)).annotate({
    description: "Ordered provider-neutral route filters; names identify filters across layers.",
  }),
});
export type RouteObjectInput = typeof RouteObjectInput.Type;

export const RouteInput = Schema.Union([Schema.NonEmptyString, RouteObjectInput]);
export type RouteInput = typeof RouteInput.Type;

/** Mount input — short ("./src:/app") or expanded form. */
export const MountInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    type: Schema.optionalKey(Schema.Literals(["bind", "tmpfs", "volume"])),
    source: Schema.optionalKey(Schema.String),
    target: Schema.String,
    readOnly: Schema.optionalKey(Schema.Boolean),
    /** Excludes (gitignore-flavoured) — bind only; realized as volume shadows. */
    excludes: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Includes — re-bind specific excluded paths. */
    includes: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
]);
export type MountInput = typeof MountInput.Type;

/** Storage input — named volume reference. */
export const StorageInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    store: Schema.String,
    target: Schema.String,
    readOnly: Schema.optionalKey(Schema.Boolean),
    scope: Schema.optionalKey(StorageScope),
    kind: Schema.optionalKey(Schema.Literals(["data", "cache"])),
    key: Schema.optionalKey(Schema.String),
  }),
]);
export type StorageInput = typeof StorageInput.Type;

/** Canonical Lando healthcheck schema; Compose-capable authoring is accepted by `ServiceConfig`. */
export const HealthcheckInput = HealthcheckCanonicalBase;
export type HealthcheckInput = typeof HealthcheckInput.Type;

export const ServiceDependency = Schema.Struct({
  service: Schema.String,
  condition: Schema.optionalKey(ServiceDependencyConditionSchema),
  required: Schema.optionalKey(Schema.Boolean),
  restart: Schema.optionalKey(Schema.Boolean),
}).annotate({
  identifier: "ServiceDependency",
  title: "Service Dependency",
  description:
    "A single inter-service dependency with its optional Compose condition, required, and restart flags.",
});
export type ServiceDependency = typeof ServiceDependency.Type;

const ServiceDependencyInput = Schema.Struct({
  condition: ServiceDependencyConditionSchema,
  required: Schema.optionalKey(Schema.Boolean),
  restart: Schema.optionalKey(Schema.Boolean),
});

const RESERVED_KEY_PROPERTY_NAMES = { not: { const: "__proto__" } } as const;

const ReservedComposeScalarMapInput = Schema.Unknown.annotate({
  jsonSchema: {
    type: "object",
    propertyNames: RESERVED_KEY_PROPERTY_NAMES,
    additionalProperties: {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
    },
  },
});

const ReservedDependencyMapInput = Schema.Unknown.annotate({
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

const reservedMapKeyFailure = (input: unknown) =>
  Effect.fail(
    new SchemaIssue.InvalidValue(
      {
        message: 'The key "__proto__" is reserved and cannot be used in a Landofile map; choose another key.',
      },
      input,
    ),
  );

const reservedMapKeyCheck = Schema.makeFilter(
  (input: unknown) => !(typeof input === "object" && input !== null && Object.hasOwn(input, "__proto__")),
  {
    message: 'The key "__proto__" is reserved and cannot be used in a Landofile map; choose another key.',
  },
);

const StringRecord = Schema.Record(Schema.String, Schema.String);
const ComposeScalarRecord = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
);

const ServiceDependencyInputRecord = ReservedDependencyMapInput.check(reservedMapKeyCheck).pipe(
  Schema.decodeTo(Schema.Record(Schema.String, ServiceDependencyInput)),
);

const ComposeScalarMapInput = ReservedComposeScalarMapInput.check(reservedMapKeyCheck).pipe(
  Schema.decodeTo(ComposeScalarRecord),
);

const ComposeEnvironmentInput = Schema.Union([ComposeScalarMapInput, Schema.Array(Schema.String)])
  .pipe(
    Schema.decodeTo(
      StringRecord,
      SchemaTransformation.transformEffect({
        decode: (input, _options) => {
          if (!Array.isArray(input)) {
            const entries = Object.entries(input);
            const unresolved = entries.find(([, value]) => value === null);
            if (unresolved !== undefined) {
              return Effect.fail(
                new SchemaIssue.InvalidValue(
                  {
                    message: `Landofile service environment entry "${unresolved[0]}" has no value; host-environment interpolation is unsupported in Landofiles — provide a concrete value.`,
                  },
                  input,
                ),
              );
            }
            return Effect.succeed(Object.fromEntries(entries.map(([key, value]) => [key, String(value)])));
          }
          const entries: Array<readonly [string, string]> = [];
          for (const entry of input) {
            const separator = entry.indexOf("=");
            if (separator < 0) {
              return Effect.fail(
                new SchemaIssue.InvalidValue(
                  {
                    message: `Landofile service environment entry "${entry}" must be KEY=value; host-environment interpolation is unsupported in Landofiles — use the map form (environment: { KEY: value }).`,
                  },
                  input,
                ),
              );
            }
            entries.push([entry.slice(0, separator), entry.slice(separator + 1)]);
          }
          const record = Object.fromEntries(entries);
          if (Object.hasOwn(record, "__proto__")) return reservedMapKeyFailure(record);
          return Effect.succeed(record);
        },
        encode: (record) => Effect.succeed(record),
      }),
    ),
  )
  .annotate({
    description:
      "Service environment variables as a map (KEY: value) or a Compose-style KEY=value list. A bare list entry or null map value is rejected because Landofiles do not read host environment variables.",
  });

const ComposeLabelsInput = Schema.Union([ComposeScalarMapInput, Schema.Array(Schema.String)])
  .pipe(
    Schema.decodeTo(
      StringRecord,
      SchemaTransformation.transformEffect({
        decode: (input, _options) => {
          if (!Array.isArray(input)) {
            return Effect.succeed(
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
          if (Object.hasOwn(record, "__proto__")) return reservedMapKeyFailure(record);
          return Effect.succeed(record);
        },
        encode: (record) => Effect.succeed(record),
      }),
    ),
  )
  .annotate({
    description:
      "Service labels as a map or a Compose-style KEY=value list; canonicalized to a map, with null and bare entries becoming empty strings.",
  });

const ComposeEnvFileInput = Schema.Union([Schema.String, Schema.Array(Schema.String)])
  .pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform({
        decode: (input) => (typeof input === "string" ? [input] : input),
        encode: (list) => list,
      }),
    ),
  )
  .annotate({
    description:
      "One or more env-file paths whose KEY=value lines seed the service environment. String or string list.",
  });

const TOP_LEVEL_ENV_FILE_DESCRIPTION =
  "One or more app-root-relative env-file paths applied to every service below service-level envFile and environment overrides.";

const TopLevelEnvFileInput = Schema.Union([Schema.String, Schema.Array(Schema.String)])
  .annotate({
    description: TOP_LEVEL_ENV_FILE_DESCRIPTION,
  })
  .pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform({
        decode: (input) => (typeof input === "string" ? [input] : input),
        encode: (paths) => paths,
      }),
    ),
  )
  .annotate({ description: TOP_LEVEL_ENV_FILE_DESCRIPTION });

const ComposeDependsOnInput = Schema.Union([
  Schema.Array(Schema.String),
  ServiceDependencyInputRecord,
  Schema.Array(ServiceDependency),
])
  .pipe(
    Schema.decodeTo(
      Schema.Array(ServiceDependency),
      SchemaTransformation.transformEffect({
        decode: (input) => {
          if (Array.isArray(input)) {
            return Effect.succeed(
              input.map((entry) => (typeof entry === "string" ? { service: entry } : entry)),
            );
          }
          return Effect.succeed(Object.entries(input).map(([service, spec]) => ({ service, ...spec })));
        },
        encode: (deps: ReadonlyArray<ServiceDependency>, _options) => {
          const allBare = deps.every(
            (dep) => dep.condition === undefined && dep.required === undefined && dep.restart === undefined,
          );
          if (allBare) return Effect.succeed(deps.map((dep) => dep.service));
          const reserved = deps.find((dep) => dep.service === "__proto__");
          if (reserved !== undefined) {
            return Effect.fail(
              new SchemaIssue.InvalidValue(
                {
                  message:
                    'The dependency service "__proto__" cannot be encoded as a map key; choose another service name.',
                },
                deps,
              ),
            );
          }
          return Effect.succeed(
            Object.fromEntries(
              deps.map((dep) => {
                const { service, ...rest } = dep;
                return [service, { ...rest, condition: rest.condition ?? "service_started" }];
              }),
            ),
          );
        },
      }),
    ),
  )
  .annotate({
    description:
      "Inter-service dependencies as a service-name list or a Compose condition-map; canonicalized to structured entries.",
  });

const ExtensionRecord = Schema.Record(Schema.TemplateLiteral(["x-", Schema.String]), Schema.Unknown).annotate(
  {
    description:
      "preserved losslessly; never interpreted by Lando or the provider; implies no vendor-specific behavior.",
  },
);

const ComposeNetworkAttachment = Schema.StructWithRest(
  Schema.Struct({
    aliases: Schema.optionalKey(Schema.Array(Schema.String)),
    interface_name: Schema.optionalKey(Schema.String),
    ipv4_address: Schema.optionalKey(Schema.String),
    ipv6_address: Schema.optionalKey(Schema.String),
    link_local_ips: Schema.optionalKey(Schema.Array(Schema.String)),
    mac_address: Schema.optionalKey(Schema.String),
    driver_opts: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
    ),
    priority: Schema.optionalKey(Schema.Number),
    gw_priority: Schema.optionalKey(Schema.Number),
  }),
  [ExtensionRecord],
);

const ComposeNetworkAttachmentRecord = Schema.Record(Schema.String, ComposeNetworkAttachment);

const COMPOSE_NETWORKS_DESCRIPTION =
  "Service network attachments as a name list or long mapping; canonicalized to a long mapping and carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.";

const ComposeNetworksInput = Schema.Union([
  Schema.Array(Schema.String),
  Schema.Record(Schema.String, Schema.Union([ComposeNetworkAttachment, Schema.Null])),
])
  .annotate({ description: COMPOSE_NETWORKS_DESCRIPTION })
  .pipe(
    Schema.decodeTo(
      ComposeNetworkAttachmentRecord,
      SchemaTransformation.transform({
        decode: (input) =>
          Array.isArray(input)
            ? Object.fromEntries(input.map((name) => [name, {}]))
            : Object.fromEntries(Object.entries(input).map(([name, attachment]) => [name, attachment ?? {}])),
        encode: (attachments) => attachments,
      }),
    ),
  )
  .annotate({ description: COMPOSE_NETWORKS_DESCRIPTION });

const ComposeConfigOrSecretEntry = Schema.StructWithRest(
  Schema.Struct({
    source: Schema.optionalKey(Schema.String),
    target: Schema.optionalKey(Schema.String),
    uid: Schema.optionalKey(Schema.String),
    gid: Schema.optionalKey(Schema.String),
    mode: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  }),
  [ExtensionRecord],
);

const composeConfigOrSecretInput = (description: string) =>
  Schema.Array(Schema.Union([Schema.String, ComposeConfigOrSecretEntry]))
    .annotate({ description })
    .pipe(
      Schema.decodeTo(
        Schema.Array(ComposeConfigOrSecretEntry),
        SchemaTransformation.transform<
          ReadonlyArray<typeof ComposeConfigOrSecretEntry.Encoded>,
          ReadonlyArray<string | typeof ComposeConfigOrSecretEntry.Type>
        >({
          decode: (entries) =>
            entries.map((entry) => (typeof entry === "string" ? { source: entry } : entry)),
          encode: (entries) => entries,
        }),
      ),
    )
    .annotate({ description });

const COMPOSE_CONFIGS_DESCRIPTION =
  "Service config grants as source-name strings or long entries; canonicalized to long entries, carried losslessly into ServicePlan.extensions.compose, capability-checked, and realized as read-only file mounts honoring source, target, and mode.";

const COMPOSE_SECRETS_DESCRIPTION =
  "Service secret grants as source-name strings or long entries; canonicalized to long entries, carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.";

const SERVICE_CERTS_DESCRIPTION =
  "Leaf TLS certificate for this service: true issues one from the active certificate authority, false disables issuance, a path supplies a custom certificate, and an object supplies an explicit certificate and key. Separate from security.ca, which adds trusted certificate authorities.";

/** Certs input — leaf TLS toggle, custom certificate path, or explicit certificate and key pair. */
const CertsInput = Schema.Union([
  Schema.Boolean,
  Schema.String,
  Schema.Struct({
    cert: Schema.String.annotate({
      description: "Path to a custom leaf certificate for this service.",
    }),
    key: Schema.String.annotate({
      description: "Path to the private key matching the custom leaf certificate.",
    }),
  }),
]).annotate({ description: SERVICE_CERTS_DESCRIPTION });

const SERVICE_SECURITY_DESCRIPTION =
  "Additional CA paths and per-service overrides for inheriting host network CA and proxy settings.";

const ServiceSecurityCaEntry = Schema.Union([Schema.String, StringImportRef]).annotate({
  jsonSchema: { acceptsImportRef: true },
});

const ServiceSecurity = Schema.Struct({
  ca: Schema.optionalKey(Schema.Array(ServiceSecurityCaEntry)).annotate({
    description: "Additional CA certificate paths for this service.",
  }),
  inheritNetworkCa: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Override whether this service inherits host network CA certificates.",
  }),
  inheritNetworkProxy: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Override whether this service inherits host network proxy settings.",
  }),
});

const ServiceSecurityCaAlias = Schema.Union([ServiceSecurityCaEntry, Schema.Array(ServiceSecurityCaEntry)]);
const Forbidden = Schema.optionalKey(Schema.Never);

const ServiceSecurityInput = Schema.Union([
  Schema.Struct({
    ca: Schema.optionalKey(Schema.Array(ServiceSecurityCaEntry)),
    cas: Forbidden,
    "certificate-authority": Forbidden,
    "certificate-authorities": Forbidden,
    inheritNetworkCa: Schema.optionalKey(Schema.Boolean),
    inheritNetworkProxy: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ca: Forbidden,
    cas: ServiceSecurityCaAlias,
    "certificate-authority": Forbidden,
    "certificate-authorities": Forbidden,
    inheritNetworkCa: Schema.optionalKey(Schema.Boolean),
    inheritNetworkProxy: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ca: Forbidden,
    cas: Forbidden,
    "certificate-authority": ServiceSecurityCaAlias,
    "certificate-authorities": Forbidden,
    inheritNetworkCa: Schema.optionalKey(Schema.Boolean),
    inheritNetworkProxy: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ca: Forbidden,
    cas: Forbidden,
    "certificate-authority": Forbidden,
    "certificate-authorities": ServiceSecurityCaAlias,
    inheritNetworkCa: Schema.optionalKey(Schema.Boolean),
    inheritNetworkProxy: Schema.optionalKey(Schema.Boolean),
  }),
]).annotate({ description: SERVICE_SECURITY_DESCRIPTION });

const ServiceSecurityField = ServiceSecurityInput.pipe(
  Schema.decodeTo(
    ServiceSecurity,
    SchemaTransformation.transform<typeof ServiceSecurity.Encoded, typeof ServiceSecurityInput.Type>({
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
    }),
  ),
).annotate({ description: SERVICE_SECURITY_DESCRIPTION });

/**
 * Login credentials a catalog service may author under `services.<name>.creds`.
 */
export const ServiceCreds = Schema.Struct({
  user: Schema.String.annotate({
    description: "Username created or used by the service.",
  }),
  password: Schema.String.annotate({
    description: "Password for the service user.",
  }),
  database: Schema.String.annotate({
    description: "Database name the service user can access.",
  }),
  rootPassword: Schema.optionalKey(Schema.String).annotate({
    description: "Optional administrative password distinct from the service user password.",
  }),
}).annotate({
  identifier: "ServiceCreds",
  title: "Service Creds",
  description: "Username, password, and database credentials for a catalog service.",
});
export type ServiceCreds = typeof ServiceCreds.Type;

/**
 * App-relative file-backed configuration a catalog service may author under
 * `services.<name>.config` (e.g. a MySQL server config file or a Solr conf directory).
 */
export const ServiceFileConfig = Schema.Struct({
  server: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "App-relative path to a regular file mounted read-only as the service's server config.",
  }),
  dir: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "App-relative path to a directory mounted read-only as the service's config directory.",
  }),
}).annotate({
  identifier: "ServiceFileConfig",
  title: "Service File Config",
  description: "App-relative file-backed service configuration mounted read-only into the container.",
});
export type ServiceFileConfig = typeof ServiceFileConfig.Type;

/**
 * The additive object form of `services.<name>.composer`, selecting a Composer
 * release and the global Composer packages installed alongside it.
 */
export const PhpComposerConfig = Schema.Struct({
  version: Schema.optionalKey(Schema.String).annotate({
    description:
      "Composer major channel or exact checksum-pinned version; omitted selects the bundled release.",
  }),
  packages: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Global Composer packages installed at build time, package name to version constraint.",
  }),
}).annotate({
  identifier: "PhpComposerConfig",
  title: "Php Composer Config",
  description: "Composer release selection plus the global Composer packages installed with it.",
});
export type PhpComposerConfig = typeof PhpComposerConfig.Type;

/**
 * ServiceConfig — what a user authors under `services.<name>:` in a Landofile.
 * Covers the fields consumed by downstream provider logic.
 */
const ServiceConfigWithExtensions = Schema.StructWithRest(
  Schema.Struct({
    api: Schema.optionalKey(Schema.Literal(4)),
    type: Schema.optionalKey(Schema.String), // defaults to "lando"
    primary: Schema.optionalKey(Schema.Boolean),

    image: Schema.optionalKey(Schema.String).annotate({
      description: "Container image reference used by the service.",
    }),
    build: Schema.optionalKey(BuildBlock),
    command: Schema.optionalKey(CommandSpec).annotate({
      description: "Command executed when the service starts.",
    }),
    entrypoint: Schema.optionalKey(CommandSpec).annotate({
      description: "Entrypoint used to launch the service container.",
    }),
    user: Schema.optionalKey(Schema.String).annotate({
      description: "Container user used to run service processes.",
    }),
    workingDirectory: Schema.optionalKey(PortablePath).annotate({
      description: "Container working directory for service processes.",
    }),
    database: Schema.optionalKey(Schema.String).annotate({
      description: "Default database, bucket, or equivalent data namespace created for the service.",
    }),
    password: Schema.optionalKey(Schema.String).annotate({
      description:
        "Redis authentication password, passed through the container environment rather than command arguments.",
    }),
    persist: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Redis disk persistence: defaults to true; false disables durable storage, AOF, and RDB snapshots.",
    }),
    creds: Schema.optionalKey(ServiceCreds).annotate({
      description: "Service login credentials used to provision or connect to the service.",
    }),
    config: Schema.optionalKey(ServiceFileConfig).annotate({
      description: "App-relative file-backed service configuration mounted read-only into the container.",
    }),
    hosts: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
      description: "Database hosts this admin UI connects to; a single hostname or a list of hostnames.",
    }),
    mailFrom: Schema.optionalKey(Schema.Union([Schema.Literal(false), Schema.Array(ServiceName)])).annotate({
      description:
        "Mailpit PHP senders: omitted selects every resolved PHP service, false selects none, and a list selects named PHP services in authored order with duplicates removed.",
    }),
    cores: Schema.optionalKey(Schema.Array(Schema.String)),
    port: Schema.optionalKey(Schema.Number).annotate({
      description: "Primary container port exposed by the service.",
    }),
    framework: Schema.optionalKey(Schema.String),
    packageRoot: Schema.optionalKey(Schema.String).annotate({
      description:
        "App-root-relative source directory used only by service-type project-file inference; it does not change mounts or the container working directory.",
    }),
    webroot: Schema.optionalKey(PortablePath).annotate({
      description: "Container path served as this service's HTTP document root.",
    }),
    backend: Schema.optionalKey(Schema.String).annotate({
      description: "Name of the app service this cache or proxy fronts.",
    }),
    allowOverride: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Whether an Apache-backed service enables .htaccess overrides for its webroot.",
    }),
    composer: Schema.optionalKey(
      Schema.Union([Schema.Literal(false), Schema.String, PhpComposerConfig]),
    ).annotate({
      description:
        "PHP Composer selection: a major channel, an exact checksum-pinned version, false to skip install, or an object carrying a version and global packages.",
    }),
    globals: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
      description:
        "Global npm packages installed at build time, package name to version specifier; authored order is normalized.",
    }),
    via: Schema.optionalKey(Schema.String).annotate({
      description: 'PHP serving mode: "apache" (default), "fpm", or "cli".',
    }),
    xdebug: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])).annotate({
      description:
        'PHP Xdebug selection: true installs with mode "debug", a comma-separated Xdebug 3 mode string, or false to skip install.',
    }),
    db_client: Schema.optionalKey(
      Schema.Union([Schema.Literal("auto"), Schema.Literal(false), Schema.String]),
    ).annotate({
      description:
        'PHP database client selection: "auto" detects database service families, false installs none, or "<family>:<version>" forces one client.',
    }),
    environment: Schema.optionalKey(ComposeEnvironmentInput),
    envFile: Schema.optionalKey(ComposeEnvFileInput).annotate({
      description:
        "One or more env-file paths (string or list) whose KEY=value lines seed the service environment.",
    }),
    labels: Schema.optionalKey(ComposeLabelsInput).annotate({
      description:
        "Service labels as a map or a Compose-style KEY=value list; canonicalized to a map, with null and bare entries becoming empty strings.",
    }),

    ...ComposeServiceKnobFields,

    ports: Schema.optionalKey(ComposePortsField).annotate({
      description:
        'Published container ports as Compose short strings ("8080:80", "127.0.0.1:8080:80/udp", "80", ranges) or long objects; canonicalized to target/published/hostIp/protocol entries that normalize into endpoints.',
    }),
    expose: Schema.optionalKey(ComposeExposeField).annotate({
      description:
        "Container-only ports exposed to other services as strings, numbers, or ranges; never host-published, and normalized into internal endpoints.",
    }),
    volumes: Schema.optionalKey(ComposeVolumesField).annotate({
      description:
        'Compose volumes as short strings ("./src:/app", "named:/data:ro", "/data") or long objects; host paths normalize into mounts, named and anonymous volumes into storage, and tmpfs into the preserved tmpfs runtime knob.',
    }),
    networks: Schema.optionalKey(ComposeNetworksInput).annotate({
      description: COMPOSE_NETWORKS_DESCRIPTION,
    }),
    configs: Schema.optionalKey(composeConfigOrSecretInput(COMPOSE_CONFIGS_DESCRIPTION)).annotate({
      description: COMPOSE_CONFIGS_DESCRIPTION,
    }),
    secrets: Schema.optionalKey(composeConfigOrSecretInput(COMPOSE_SECRETS_DESCRIPTION)).annotate({
      description: COMPOSE_SECRETS_DESCRIPTION,
    }),
    profiles: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description:
        "Compose profile names; carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.",
    }),

    appMount: Schema.optionalKey(
      Schema.Union([
        Schema.Literal(false),
        Schema.Struct({
          target: Schema.String,
          readOnly: Schema.optionalKey(Schema.Boolean),
          excludes: Schema.optionalKey(Schema.Array(Schema.String)),
          includes: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ]),
    ).annotate({
      description: "Application source mount configuration, or false to disable the app mount.",
    }),
    mounts: Schema.optionalKey(Schema.Array(MountInput)).annotate({
      description: "Additional host or managed-file mounts attached to the service.",
    }),
    storage: Schema.optionalKey(Schema.Array(StorageInput)).annotate({
      description: "Persistent or cached storage attached to the service.",
    }),
    home: Schema.optionalKey(
      Schema.Union([
        Schema.Literal(false),
        Schema.Struct({
          path: Schema.optionalKey(AbsoluteContainerPath),
        }),
      ]),
    ).annotate({
      description:
        "Persist the planned user's home directory, or false to disable it. Set path to choose the destination when the image's home is not known.",
    }),

    scanner: Schema.optionalKey(ScannerConfig).annotate({
      description: "How the post-start URL scan probes this service, or false to skip it.",
    }),
    endpoints: Schema.optionalKey(Schema.Array(EndpointInput)).annotate({
      description: "Internal or published network endpoints exposed by the service.",
    }),
    routes: Schema.optionalKey(Schema.Array(RouteInput)).annotate({
      description: "Hostnames routed to service endpoints.",
    }),

    healthcheck: Schema.optionalKey(HealthcheckField).annotate({
      description:
        "Healthcheck as canonical Lando fields or Compose test, disable, and duration spellings; canonicalized to the Lando healthcheck model while preserving start_interval losslessly.",
    }),
    logs: Schema.optionalKey(Schema.Array(LogSourceInput)),
    certs: Schema.optionalKey(CertsInput).annotate({ description: SERVICE_CERTS_DESCRIPTION }),
    hostnames: Schema.optionalKey(Schema.Array(Schema.String)),
    security: Schema.optionalKey(ServiceSecurityField).annotate({
      description: SERVICE_SECURITY_DESCRIPTION,
    }),
    dependsOn: Schema.optionalKey(ComposeDependsOnInput),

    providers: Schema.optionalKey(ProviderExtensionConfig).annotate({
      description: "Provider-specific service configuration keyed by provider id.",
    }),
  }),
  [ExtensionRecord],
);

export const ServiceConfig = Object.assign(ServiceConfigWithExtensions, {
  fields: ServiceConfigWithExtensions.schema.fields,
});
export type ServiceConfig = typeof ServiceConfig.Type;

/**
 * ServiceConfigInput — the accepted authoring surface: every {@link ServiceConfig}
 * key plus the Compose cross-key spellings (`working_dir`, `env_file`,
 * `depends_on`) and service security CA aliases. Used as the decode boundary
 * for `services.<name>:`.
 */
export const ServiceConfigInput = Schema.StructWithRest(
  Schema.Struct(ServiceConfig.schema.fields).mapFields((fields) => ({
    ...fields,
    working_dir: Schema.optionalKey(PortablePath).annotate({
      description: "Compose alias for the canonical workingDirectory service field.",
    }),
    env_file: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
      description: "Compose alias for the canonical envFile service field; accepts one path or a path list.",
    }),
    depends_on: Schema.optionalKey(
      Schema.Union([Schema.Array(Schema.String), ServiceDependencyInputRecord]),
    ).annotate({
      description:
        "Compose alias for the canonical dependsOn service field; accepts a service-name list or condition map.",
    }),
  })),
  [ExtensionRecord],
)
  .pipe(Schema.toEncoded)
  .annotate({
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
const ServiceConfigDecode = ServiceConfigInput.pipe(
  Schema.decodeTo(
    ServiceConfig,
    SchemaTransformation.transformEffect({
      decode: (input) => {
        const { working_dir, env_file, depends_on, ...rest } = input as Record<string, unknown>;
        const canonical: Record<string, unknown> = { ...rest };
        if (canonical.workingDirectory === undefined && working_dir !== undefined) {
          canonical.workingDirectory = working_dir;
        }
        if (canonical.envFile === undefined && env_file !== undefined) canonical.envFile = env_file;
        if (canonical.dependsOn === undefined && depends_on !== undefined) canonical.dependsOn = depends_on;
        return Effect.succeed(canonical);
      },
      encode: (encoded) => Effect.succeed(encoded),
    }),
  ),
);

/**
 * ToolingVarLiteral — a scalar literal value for a Landofile `tooling.<task>.vars.<name>`.
 */
export const ToolingVarLiteral = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
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
export const ToolingVar = Schema.Union([
  ToolingVarLiteral,
  ToolingVarDefault,
  ToolingVarSh,
  ToolingVarPrompt,
]);
export type ToolingVar = typeof ToolingVar.Type;

const ToolingEnvironment = Schema.Record(Schema.String, ToolingVarLiteral).annotate({
  description: "Environment variables supplied to a tooling task as scalar values.",
});

export const ToolingFlagShape = Schema.Struct({
  alias: Schema.optionalKey(Schema.String).annotate({
    description: "Optional single-token alias for this flag.",
  }),
  choices: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Allowed values for this flag.",
  }),
  boolean: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether this flag is a boolean switch instead of a value-taking option.",
  }),
  required: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether this flag must be supplied.",
  }),
  description: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(ToolingVarLiteral),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type ToolingFlagShape = typeof ToolingFlagShape.Type;

export const ToolingArgShape = Schema.Struct({
  choices: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Allowed values for this argument.",
  }),
  order: Schema.optionalKey(
    Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ).annotate({
    description: "Positional order of this argument within the task.",
  }),
  description: Schema.optionalKey(Schema.String),
  required: Schema.optionalKey(Schema.Boolean),
  default: Schema.optionalKey(ToolingVarLiteral),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type ToolingArgShape = typeof ToolingArgShape.Type;

export const ToolingStepShape = Schema.Struct({
  cmd: Schema.String.annotate({ description: "Shell command executed for this step." }),
  service: Schema.optionalKey(Schema.String).annotate({
    description: "Service this step runs in; overrides the task service.",
  }),
  dir: Schema.optionalKey(PortablePath).annotate({
    description: "Working directory for this step; overrides the task directory.",
  }),
  user: Schema.optionalKey(Schema.String).annotate({
    description: "User this step runs as; overrides the task user.",
  }),
  env: Schema.optionalKey(ToolingEnvironment).annotate({
    description: "Environment overlaid on the task environment for this step.",
  }),
});
export type ToolingStepShape = typeof ToolingStepShape.Type;

export const AppLifecycleEventName = Schema.Literals([
  "pre-init",
  "post-init",
  "pre-start",
  "post-start",
  "pre-stop",
  "post-stop",
  "pre-restart",
  "post-restart",
  "pre-rebuild",
  "post-rebuild",
  "pre-destroy",
  "post-destroy",
]).annotate({ description: "App lifecycle point that runs an ordered Landofile event step list." });
export type AppLifecycleEventName = typeof AppLifecycleEventName.Type;

export const ToolingEventName = Schema.TemplateLiteral([Schema.Literals(["pre-", "post-"]), Schema.String]);
export type ToolingEventName = typeof ToolingEventName.Type;

export const LandofileEventName = Schema.Union([AppLifecycleEventName, ToolingEventName]);
export type LandofileEventName = typeof LandofileEventName.Type;

const EventStepCondition = Schema.Union([Schema.String, Schema.Boolean]);

/**
 * Scalar literal or homogeneous scalar array for a canonical `command:` flag/arg.
 * Arrays support `multiple` inputs; mixed types and objects fail closed.
 */
export const EventCommandInputValue = Schema.Union([
  ToolingVarLiteral,
  Schema.Array(Schema.String),
  Schema.Array(Schema.Number),
  Schema.Array(Schema.Boolean),
]);
export type EventCommandInputValue = typeof EventCommandInputValue.Type;

export const EventCommandStep = Schema.Struct({
  cmd: Schema.optionalKey(Schema.Never),
  task: Schema.optionalKey(Schema.Never),
  command: Schema.String,
  defer: Schema.optionalKey(Schema.Never),
  for: Schema.optionalKey(Schema.Never),
  flags: Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
  args: Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
  raw: Schema.optionalKey(Schema.Array(Schema.String)),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
}).annotate({
  identifier: "EventCommandStep",
  description: "Direct invocation of a canonical Lando command.",
});
export type EventCommandStep = typeof EventCommandStep.Type;

export const EventTaskStep = Schema.Struct({
  cmd: Schema.optionalKey(Schema.Never),
  task: Schema.String,
  command: Schema.optionalKey(Schema.Never),
  defer: Schema.optionalKey(Schema.Never),
  for: Schema.optionalKey(Schema.Never),
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
}).annotate({
  identifier: "EventTaskStep",
  description: "Invocation of an effective Landofile tooling task.",
});
export type EventTaskStep = typeof EventTaskStep.Type;

export const EventCmdStep = Schema.Struct({
  cmd: Schema.String,
  task: Schema.optionalKey(Schema.Never),
  command: Schema.optionalKey(Schema.Never),
  defer: Schema.optionalKey(Schema.Never),
  for: Schema.optionalKey(Schema.Never),
  service: Schema.optionalKey(Schema.String),
  dir: Schema.optionalKey(PortablePath),
  env: Schema.optionalKey(ToolingEnvironment),
  user: Schema.optionalKey(Schema.String),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
}).annotate({
  identifier: "EventCmdStep",
  description: "Provider tooling command with optional service targeting.",
});
export type EventCmdStep = typeof EventCmdStep.Type;

const EventForVarSelector = Schema.Struct({
  var: Schema.String,
  matrix: Schema.optionalKey(Schema.Never),
  sources: Schema.optionalKey(Schema.Never),
  generates: Schema.optionalKey(Schema.Never),
});

const EventForMatrixSelector = Schema.Struct({
  var: Schema.optionalKey(Schema.Never),
  matrix: Schema.Record(Schema.String, Schema.Array(ToolingVarLiteral)),
  sources: Schema.optionalKey(Schema.Never),
  generates: Schema.optionalKey(Schema.Never),
});

const EventForSourcesSelector = Schema.Struct({
  var: Schema.optionalKey(Schema.Never),
  matrix: Schema.optionalKey(Schema.Never),
  sources: Schema.Literal(true),
  generates: Schema.optionalKey(Schema.Never),
});

const EventForGeneratesSelector = Schema.Struct({
  var: Schema.optionalKey(Schema.Never),
  matrix: Schema.optionalKey(Schema.Never),
  sources: Schema.optionalKey(Schema.Never),
  generates: Schema.Literal(true),
});

export const EventForSelector = Schema.Union([
  Schema.Array(ToolingVarLiteral),
  EventForVarSelector,
  EventForMatrixSelector,
  EventForSourcesSelector,
  EventForGeneratesSelector,
]).annotate({
  identifier: "EventForSelector",
  description: "Literal or task-derived values selected for an event step loop.",
});
export type EventForSelector = typeof EventForSelector.Type;

const EventDeferredCmdShorthand = Schema.Struct({
  cmd: Schema.optionalKey(Schema.Never),
  task: Schema.optionalKey(Schema.Never),
  command: Schema.optionalKey(Schema.Never),
  defer: Schema.String,
  for: Schema.optionalKey(Schema.Never),
  service: Schema.optionalKey(Schema.String),
  dir: Schema.optionalKey(PortablePath),
  env: Schema.optionalKey(ToolingEnvironment),
  user: Schema.optionalKey(Schema.String),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
});

const EventDeferredCmdStep = Schema.Struct({
  cmd: Schema.String,
  task: Schema.optionalKey(Schema.Never),
  command: Schema.optionalKey(Schema.Never),
  defer: Schema.Literal(true),
  for: Schema.optionalKey(Schema.Never),
  service: Schema.optionalKey(Schema.String),
  dir: Schema.optionalKey(PortablePath),
  env: Schema.optionalKey(ToolingEnvironment),
  user: Schema.optionalKey(Schema.String),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
});

const EventDeferredTaskStep = Schema.Struct({
  cmd: Schema.optionalKey(Schema.Never),
  task: Schema.String,
  command: Schema.optionalKey(Schema.Never),
  defer: Schema.Literal(true),
  for: Schema.optionalKey(Schema.Never),
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
});

const EventDeferredCommandStep = Schema.Struct({
  cmd: Schema.optionalKey(Schema.Never),
  task: Schema.optionalKey(Schema.Never),
  command: Schema.String,
  defer: Schema.Literal(true),
  for: Schema.optionalKey(Schema.Never),
  flags: Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
  args: Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
  raw: Schema.optionalKey(Schema.Array(Schema.String)),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
});

export const EventDeferStep = Schema.Union([
  EventDeferredCmdShorthand,
  EventDeferredCmdStep,
  EventDeferredTaskStep,
  EventDeferredCommandStep,
]).annotate({
  identifier: "EventDeferStep",
  description: "An event action registered for LIFO finalization.",
});
export type EventDeferStep = typeof EventDeferStep.Type;

const EventForCmdStep = Schema.Struct({
  cmd: Schema.String,
  task: Schema.optionalKey(Schema.Never),
  command: Schema.optionalKey(Schema.Never),
  defer: Schema.optionalKey(Schema.Never),
  for: EventForSelector,
  service: Schema.optionalKey(Schema.String),
  dir: Schema.optionalKey(PortablePath),
  env: Schema.optionalKey(ToolingEnvironment),
  user: Schema.optionalKey(Schema.String),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
});

const EventForTaskStep = Schema.Struct({
  cmd: Schema.optionalKey(Schema.Never),
  task: Schema.String,
  command: Schema.optionalKey(Schema.Never),
  defer: Schema.optionalKey(Schema.Never),
  for: EventForSelector,
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
});

const EventForCommandStep = Schema.Struct({
  cmd: Schema.optionalKey(Schema.Never),
  task: Schema.optionalKey(Schema.Never),
  command: Schema.String,
  defer: Schema.optionalKey(Schema.Never),
  for: EventForSelector,
  flags: Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
  args: Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
  raw: Schema.optionalKey(Schema.Array(Schema.String)),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
});

const EventForDeferredCmdStep = Schema.Struct({
  cmd: Schema.optionalKey(Schema.Never),
  task: Schema.optionalKey(Schema.Never),
  command: Schema.optionalKey(Schema.Never),
  defer: Schema.String,
  for: EventForSelector,
  service: Schema.optionalKey(Schema.String),
  dir: Schema.optionalKey(PortablePath),
  env: Schema.optionalKey(ToolingEnvironment),
  user: Schema.optionalKey(Schema.String),
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
});

export const EventForStep = Schema.Union([
  EventForCmdStep,
  EventForTaskStep,
  EventForCommandStep,
  EventForDeferredCmdStep,
]).annotate({
  identifier: "EventForStep",
  description: "An event action repeated for each selected value.",
});
export type EventForStep = typeof EventForStep.Type;

export const EventStep = Schema.Union([
  Schema.String,
  EventCmdStep,
  EventTaskStep,
  EventCommandStep,
  EventDeferStep,
  EventForStep,
]).annotate({
  identifier: "EventStep",
  description: "One ordered events-as-tasks step.",
});
export type EventStep = typeof EventStep.Type;

export const LandofileEvents = Schema.StructWithRest(
  Schema.Struct({
    "pre-init": Schema.optionalKey(Schema.Array(EventStep)),
    "post-init": Schema.optionalKey(Schema.Array(EventStep)),
    "pre-start": Schema.optionalKey(Schema.Array(EventStep)),
    "post-start": Schema.optionalKey(Schema.Array(EventStep)),
    "pre-stop": Schema.optionalKey(Schema.Array(EventStep)),
    "post-stop": Schema.optionalKey(Schema.Array(EventStep)),
    "pre-restart": Schema.optionalKey(Schema.Array(EventStep)),
    "post-restart": Schema.optionalKey(Schema.Array(EventStep)),
    "pre-rebuild": Schema.optionalKey(Schema.Array(EventStep)),
    "post-rebuild": Schema.optionalKey(Schema.Array(EventStep)),
    "pre-destroy": Schema.optionalKey(Schema.Array(EventStep)),
    "post-destroy": Schema.optionalKey(Schema.Array(EventStep)),
  }),
  [Schema.Record(Schema.String, Schema.Array(EventStep))],
).annotate({
  identifier: "LandofileEvents",
  description: "Ordered tasks keyed by lifecycle or tooling event name, validated after tooling resolution.",
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
 * - `cmds:` — sequential shell commands or command steps with execution overrides.
 * - `arguments: false` — reject caller-supplied positional arguments.
 * - `dir:` — task working directory.
 * - `env:` — task environment overrides.
 * - `vars:` — accepted `ToolingVar` forms only.
 *
 * Supported deprecation metadata:
 * `deprecated:`, `flags.<name>.deprecated:`, and `args.<name>.deprecated:`.
 *
 * Unsupported fields rejected by `LandofileService` with remediation:
 * `deps:`, non-command step-objects in `cmds:` (`task:`, `command:`, `defer:`,
 * `for:`), `engine:`, `bootstrap:`, `dotenv:`,
 * `appMount:`, `stdio:`, `interactive:`,
 * `passThrough:`, `sources:`, `generates:`, `method:`, `status:`,
 * `preconditions:`, `if:`, `run:`, `platforms:`, `prompt:` (task-level),
 * `silent:`, `output:`, `failFast:`, `aliases:`,
 * `topLevelAlias:`, `namespace:`, `internal:`, `hostProxyAllowed:`,
 * `examples:`, `usage:`.
 */
export const ToolingTaskShape = Schema.Struct({
  user: Schema.optionalKey(Schema.String).annotate({
    description: "User that the task's commands run as inside the target service.",
  }),
  disabled: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Disables the task so it is hidden from listings and refused at execution.",
  }),
  service: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  cmd: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  cmds: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, ToolingStepShape]))).annotate({
    description: "Ordered shell commands or command steps with task-local execution overrides.",
  }),
  arguments: Schema.optionalKey(Schema.Literal(false)).annotate({
    description: "Set to false to reject caller-supplied positional arguments for this task.",
  }),
  dir: Schema.optionalKey(PortablePath).annotate({
    description: "Working directory used when the tooling task runs.",
  }),
  env: Schema.optionalKey(ToolingEnvironment).annotate({
    description: "Environment variables applied to this tooling task after app-wide tooling defaults.",
  }),
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVar)),
  deprecated: Schema.optionalKey(DeprecationNotice),
  flags: Schema.optionalKey(Schema.Record(Schema.String, ToolingFlagShape)),
  args: Schema.optionalKey(Schema.Record(Schema.String, ToolingArgShape)),
});
export type ToolingTaskShape = typeof ToolingTaskShape.Type;

/** App-wide defaults inherited by tooling tasks unless a task overrides them. */
export const ToolingDefaultsShape = Schema.Struct({
  service: Schema.optionalKey(Schema.String).annotate({
    description: "Default service target inherited by tooling tasks.",
  }),
  dir: Schema.optionalKey(PortablePath).annotate({
    description: "Default working directory inherited by tooling tasks.",
  }),
  env: Schema.optionalKey(ToolingEnvironment).annotate({
    description: "Default environment variables inherited by tooling tasks.",
  }),
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVar)).annotate({
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
  service: Schema.optionalKey(Schema.String),
  desc: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
});
export type BunShellScriptFrontMatter = typeof BunShellScriptFrontMatter.Type;

/**
 * ToolingIncludeShape — one entry of the `toolingIncludes:` shorthand map.
 * The map key is the include namespace; the entry names a local tooling
 * fragment carrying only `tooling:` and `toolingIncludes:`.
 *
 * Deliberately omitted: `dir:` (set it on individual tasks instead) and
 * `checksum:` (tooling fragments are local-file only, so there is no remote
 * source to pin).
 */
export const ToolingIncludeShape = Schema.Struct({
  file: Schema.String.annotate({
    description:
      "Path to the tooling fragment, resolved relative to the file that declares the include and contained under the app root.",
  }),
  optional: Schema.optionalKey(Schema.Boolean).annotate({
    description: "When true, a missing fragment file is skipped instead of failing the load.",
  }),
  flatten: Schema.optionalKey(Schema.Boolean).annotate({
    description: "When true, included task names register unprefixed instead of under the include namespace.",
  }),
  internal: Schema.optionalKey(Schema.Boolean).annotate({
    description: "When true, every task contributed by this include is registered hidden.",
  }),
  aliases: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Additional namespaces the included tasks also register under.",
  }),
  excludes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Fragment task names dropped before flattening or namespace registration.",
  }),
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)).annotate({
    description: "Literal vars applied to every included task unless the task defines its own value.",
  }),
});
export type ToolingIncludeShape = typeof ToolingIncludeShape.Type;

export const IncludeEntry = Schema.Union([
  Schema.String,
  Schema.Struct({
    source: Schema.String,
    kind: Schema.optionalKey(Schema.Literals(["landofile", "compose", "tooling"])).annotate({
      description:
        'The fragment content semantics: "landofile" is a Landofile fragment; "compose" is a Compose fragment routed through the same parser, rejection, and decode path; "tooling" is a tooling fragment carrying only tooling: and toolingIncludes:. This is not source transport.',
    }),
    path: Schema.optionalKey(Schema.String),
    version: Schema.optionalKey(Schema.String),
    checksum: Schema.optionalKey(Schema.String),
    namespace: Schema.optionalKey(Schema.String).annotate({
      description:
        'kind: "tooling" only — the sub-namespace included tasks register under. Required unless flatten is true.',
    }),
    flatten: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        'kind: "tooling" only — when true, included task names register unprefixed instead of under the include namespace.',
    }),
    internal: Schema.optionalKey(Schema.Boolean).annotate({
      description: 'kind: "tooling" only — when true, every task contributed by this include is hidden.',
    }),
    optional: Schema.optionalKey(Schema.Boolean).annotate({
      description: 'kind: "tooling" only — when true, a missing fragment file is skipped instead of failing.',
    }),
    aliases: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description: 'kind: "tooling" only — additional namespaces the included tasks also register under.',
    }),
    excludes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description:
        'kind: "tooling" only — fragment task names dropped before flattening or namespace registration.',
    }),
    vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)).annotate({
      description:
        'kind: "tooling" only — literal vars applied to every included task unless the task defines its own value.',
    }),
  }),
]);
export type IncludeEntry = typeof IncludeEntry.Type;

export const ComposeSecretConfig = Schema.Struct({
  file: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(Schema.String),
  external: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.String),
});
export type ComposeSecretConfig = typeof ComposeSecretConfig.Type;

export { SshAgentConfig } from "./agent-forwarding.ts";

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
  name: Schema.optionalKey(Schema.String),
  external: Schema.optionalKey(Schema.Boolean),
  driver: Schema.optionalKey(Schema.String),
});

const ComposeNamedNetworkConfig = Schema.Union([ComposeNamedResourceConfig, Schema.Null]).pipe(
  Schema.decodeTo(
    ComposeNamedResourceConfig,
    SchemaTransformation.transform({ decode: (config) => config ?? {}, encode: (config) => config }),
  ),
);

const ComposeConfigConfig = Schema.Struct({
  file: Schema.optionalKey(Schema.String),
  external: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.String),
});

export const CommandAliasesShape = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether top-level command aliases are enabled for this app. Defaults to true.",
  }),
  disabled: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Top-level alias tokens disabled for this app; canonical command ids remain callable.",
  }),
  custom: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "App-specific top-level alias tokens mapped to canonical command ids.",
  }),
}).annotate({ identifier: "CommandAliasesShape", title: "Command Aliases" });
export type CommandAliasesShape = typeof CommandAliasesShape.Type;

/**
 * LandofileShape — the authored Landofile shape.
 * Excludes fields not modeled here: keys:, plugins:, pluginDirs:.
 */
const LandofileShapeBase = Schema.Struct({
  name: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "User-facing app name. Runtime identity is a lowercase ASCII slug: non-alphanumeric runs become one hyphen, edge hyphens are removed, and the result is capped at 57 characters so the lando-<slug> network label stays within DNS's 63-character limit. Names with no ASCII alphanumeric characters use a stable app-root hash.",
    }),
  ),
  runtime: Schema.optionalKey(Schema.Literal(4)),
  lando: Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(
        Schema.makeFilter(
          (range) => range.trim().length > 0 && validRange(range, { loose: false }) !== null,
          {
            message: 'lando must be a valid npm semver range such as ">=4.1 <5", "^4", or "4.x".',
          },
        ),
      ),
    ),
  ).annotate({
    description:
      'Semver range the running Lando core version must satisfy before the app is planned or started (e.g. ">=4.1 <5"). Prereleases are included; unsatisfied constraints fail closed with remediation.',
  }),
  recipe: Schema.optionalKey(
    LandofileRecipeField.annotate({
      description:
        "Recipe id, or inert object-form provenance recording the producing recipe and its merged options.",
    }),
  ),
  provider: Schema.optionalKey(ProviderId),
  toolingEngine: Schema.optionalKey(Schema.String),
  commandAliases: Schema.optionalKey(CommandAliasesShape).annotate({
    description: "Per-app top-level command alias remapping and disablement policy.",
  }),
  agentEnv: Schema.optionalKey(Schema.Boolean),
  version: Schema.optionalKey(Schema.String),
  includes: Schema.optionalKey(Schema.Array(IncludeEntry)),
  include: Schema.optionalKey(Schema.Array(Schema.String)),
  remotes: Schema.optionalKey(Schema.Record(Schema.String, RemoteConfig)),
  sync: Schema.optionalKey(Schema.Record(Schema.String, DatasetBinding)),
  volumes: Schema.optionalKey(Schema.Record(Schema.String, ComposeNamedResourceConfig)),
  networks: Schema.optionalKey(Schema.Record(Schema.String, ComposeNamedNetworkConfig)),
  configs: Schema.optionalKey(Schema.Record(Schema.String, ComposeConfigConfig)),
  secrets: Schema.optionalKey(Schema.Record(Schema.String, ComposeSecretConfig)),
  env_file: Schema.optionalKey(TopLevelEnvFileInput),
  sshAgent: Schema.optionalKey(SshAgentConfig).annotate({
    description: "App SSH-agent forwarding policy, overriding global settings per field.",
  }),
  gpgAgent: Schema.optionalKey(GpgAgentConfig).annotate({
    description: "App GPG-agent forwarding policy, overriding global settings per field.",
  }),
  services: Schema.optionalKey(Schema.Record(ServiceName, ServiceConfigDecode)),
  proxy: Schema.optionalKey(Schema.Record(ServiceName, Schema.Array(RouteInput))),
  router: Schema.optionalKey(RouterConfig).annotate({
    description: "App-authored shared-router bind address and port policy.",
  }),
  providers: Schema.optionalKey(ProviderExtensionConfig),
  toolingDefaults: Schema.optionalKey(ToolingDefaultsShape).annotate({
    description: "App-wide service, directory, environment, and variable defaults for tooling tasks.",
  }),
  tooling: Schema.optionalKey(Schema.Record(Schema.String, ToolingTaskShape)),
  events: Schema.optionalKey(LandofileEvents),
  toolingIncludes: Schema.optionalKey(Schema.Record(Schema.String, ToolingIncludeShape)).annotate({
    description:
      "Shorthand map of tooling-fragment includes keyed by include namespace; equivalent to includes: entries with kind: tooling.",
  }),
});

export const LandofileShape = LandofileShapeBase.pipe((self) =>
  Schema.StructWithRest(self, [Schema.Record(Schema.TemplateLiteral(["x-", Schema.String]), Schema.Unknown)]),
);
export type LandofileShape = typeof LandofileShape.Type;

export const defineLandofile = <T extends LandofileShape>(value: T): T => value;
