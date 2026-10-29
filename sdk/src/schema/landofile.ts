import { SchemaIssue } from "effect";
import { Effect, SchemaTransformation } from "effect";
import { Schema } from "effect";
import validRange from "semver/ranges/valid.js";

import { GpgAgentConfig, SshAgentConfig } from "./agent-forwarding.ts";
import { BuildBlock } from "./build-block.ts";
import { HealthcheckInput } from "./compose-healthcheck.ts";
import { ComposeExposeField, ComposePortsField } from "./compose-ports.ts";
import { ComposeServiceKnobFields, ComposeTmpfsServiceField } from "./compose-service-knobs.ts";
import { ComposeVolumesField } from "./compose-volumes.ts";
import { ServiceCreds } from "./database-connection.ts";
import { DeprecationNotice } from "./deprecation.ts";
import { EndpointInput } from "./endpoint.ts";
import { ComposeEnvironmentInput } from "./environment-input.ts";
import { EnvironmentValue } from "./environment-value.ts";
import { LandofileEvents } from "./landofile-events.ts";
import { StringImportRef } from "./landofile-reference.ts";
import { type LayerMergeRule, layerMerge } from "./layer-merge.ts";
import { LogSourceInput } from "./log-source.ts";
import { mapInputWithPrecheck } from "./map-input.ts";
import { StorageScope } from "./mounts.ts";
import { ScannerConfig } from "./networking.ts";
import {
  AbsoluteContainerPath,
  CommandSpec,
  ContainerUser,
  PortNumber,
  PortablePath,
  ProviderExtensionConfig,
  ProviderId,
  ServiceName,
  ToolingEnvironment,
  ToolingVarLiteral,
} from "./primitives.ts";
import { RouterConfig } from "./proxy.ts";
import { LandofileRecipeField } from "./recipe-provenance.ts";
import { DatasetBinding, RemoteConfig } from "./remote-sync.ts";
import { RouteFilter } from "./route-filter.ts";
import { ServiceDependencyCondition as ServiceDependencyConditionSchema } from "./service-dependency.ts";
import { ToolingAuthoredInputFields } from "./tooling-input.ts";
import { toolingTaskStringConstraints } from "./tooling-task-string.ts";
export { ToolingFlagShape, ToolingArgShape } from "./tooling-input.ts";

// Landofile input shape — what a user authors (services:, routes:, etc.).
const REPLACE = { kind: "replace" } as const;
const ROUTE_MERGE = {
  kind: "keyed",
  identity: "route-match",
  whenUnkeyed: "replace",
  onMatch: "merge",
} as const;
const DEPENDENCY_MERGE = {
  kind: "keyed",
  identity: "dependency-service",
  whenUnkeyed: "replace",
  onMatch: "merge",
} as const;
const keyedMerge = (identity: Extract<LayerMergeRule, { kind: "keyed" }>["identity"]): LayerMergeRule => ({
  kind: "keyed",
  identity,
  whenUnkeyed: "replace",
  onMatch: "merge",
});

export { EndpointInput } from "./endpoint.ts";
export { BuildBlock } from "./build-block.ts";
export { ServiceDependencyCondition } from "./service-dependency.ts";

/** Route input as authored under `services.<name>.routes` (or top-level `proxy:`). */
export const RouteObjectInput = Schema.Struct({
  hostname: Schema.String.annotate({
    description: "Host pattern only, without a port or path; use endpoint and pathPrefix for those.",
  }),
  scheme: Schema.optionalKey(Schema.Literals(["http", "https", "both"])).annotate({
    description: "HTTP or HTTPS schemes served by this route.",
  }),
  endpoint: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])).annotate({
    description: "Target service endpoint name or port.",
  }),
  pathPrefix: Schema.optionalKey(Schema.String).annotate({
    description: "Request path prefix to match, beginning with / and without a query string or fragment.",
  }),
  filters: Schema.optionalKey(
    layerMerge(Schema.Array(RouteFilter), {
      kind: "keyed",
      identity: "filter-name-or-type",
      whenUnkeyed: "replace",
      onMatch: "replace-on-type-change",
    }),
  ).annotate({
    description: "Ordered provider-neutral route filters; names identify filters across layers.",
  }),
});
export type RouteObjectInput = typeof RouteObjectInput.Type;

export const RouteInput = Schema.Union([Schema.NonEmptyString, RouteObjectInput]).annotate({
  identifier: "RouteInput",
  expected: "a non-empty route shorthand string or route object",
  message: "Expected a non-empty route shorthand string or route object",
});
export type RouteInput = typeof RouteInput.Type;

/** Mount input — short ("./src:/app") or expanded form. */
const MOUNT_INPUT_DESCRIPTION =
  "Service mount as a short source:target string or an expanded bind, tmpfs, or volume object.";
export const MountInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    type: Schema.optionalKey(Schema.Literals(["bind", "tmpfs", "volume"])),
    source: Schema.optionalKey(Schema.String),
    target: Schema.String,
    readOnly: Schema.optionalKey(Schema.Boolean),
    excludes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description:
        "Bind mounts only: paths beneath the bind that become service-owned volume shadows. Use includes instead of ! entries.",
    }),
    includes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description:
        "Bind mounts only: exact paths cancel excludes; literal relative paths nested beneath a shadow reopen host directories. No ! entries or glob patterns.",
    }),
  }),
]).annotate({ description: MOUNT_INPUT_DESCRIPTION, expected: "a source:target string or a mount object" });
export type MountInput = typeof MountInput.Type;

/** Storage input — named volume reference. */
const STORAGE_INPUT_DESCRIPTION =
  "Named data or cache volume as a short target path or an expanded store object with optional scope, kind, and key.";
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
]).annotate({ description: STORAGE_INPUT_DESCRIPTION, expected: "a target path string or a storage object" });
export type StorageInput = typeof StorageInput.Type;

export { HealthcheckInput } from "./compose-healthcheck.ts";

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

const ReservedDependencyMapInput = Schema.Record(Schema.String, ServiceDependencyInput);

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
    toJsonSchema: () => ({ propertyNames: RESERVED_KEY_PROPERTY_NAMES }),
  },
);

const StringRecord = Schema.Record(Schema.String, Schema.String);
const ComposeScalarRecord = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
);

const ServiceDependencyInputRecord = mapInputWithPrecheck(ReservedDependencyMapInput, reservedMapKeyCheck);

const ComposeScalarMapInput = mapInputWithPrecheck(
  ComposeScalarRecord,
  reservedMapKeyCheck,
  Schema.Record(
    ComposeScalarRecord.key,
    Schema.Union(
      ComposeScalarRecord.value.members.map((member) => (member === Schema.Number ? Schema.Finite : member)),
    ),
  ),
);

const COMPOSE_LABELS_DESCRIPTION =
  "Service labels as a map or a Compose-style KEY=value list; canonicalized to a map, with null and bare entries becoming empty strings.";

const ComposeLabelsInput = Schema.Union([ComposeScalarMapInput, Schema.Array(Schema.String)])
  .annotate({ description: COMPOSE_LABELS_DESCRIPTION })
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
  .annotate({ description: COMPOSE_LABELS_DESCRIPTION });

const COMPOSE_ENV_FILE_DESCRIPTION =
  "One or more env-file paths (string or list) whose KEY=value lines seed the service environment.";

const ComposeEnvFileInput = Schema.Union([Schema.String, Schema.Array(Schema.String)])
  .annotate({ description: COMPOSE_ENV_FILE_DESCRIPTION })
  .pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform({
        decode: (input) => (typeof input === "string" ? [input] : input),
        encode: (list) => list,
      }),
    ),
  )
  .annotate({ description: COMPOSE_ENV_FILE_DESCRIPTION });

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

const COMPOSE_DEPENDS_ON_DESCRIPTION =
  "Inter-service dependencies as a service-name list or a Compose condition-map; canonicalized to structured entries.";

const ComposeDependsOnInput = Schema.Union([
  layerMerge(Schema.Array(Schema.String), DEPENDENCY_MERGE),
  layerMerge(ServiceDependencyInputRecord, DEPENDENCY_MERGE),
  layerMerge(Schema.Array(ServiceDependency), DEPENDENCY_MERGE),
])
  .annotate({ description: COMPOSE_DEPENDS_ON_DESCRIPTION })
  .pipe(
    Schema.decodeTo(
      layerMerge(Schema.Array(ServiceDependency), DEPENDENCY_MERGE),
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
  .pipe((schema) => layerMerge(schema, DEPENDENCY_MERGE))
  .annotate({ description: COMPOSE_DEPENDS_ON_DESCRIPTION });

const ExtensionRecord = Schema.Record(Schema.TemplateLiteral(["x-", Schema.String]), Schema.Unknown).annotate(
  {
    description:
      "preserved losslessly; never interpreted by Lando or the provider; implies no vendor-specific behavior.",
  },
);

const ComposeNetworkAttachment = Schema.StructWithRest(
  Schema.Struct({
    aliases: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [ExtensionRecord],
);

const ComposeNetworkAttachmentRecord = Schema.Record(Schema.String, ComposeNetworkAttachment);

const COMPOSE_NETWORKS_DESCRIPTION =
  "Extra networks this service joins, as a name list or long mapping keyed by a top-level networks: entry or default (the app network). Membership is additive: the service always stays on its app network. aliases add DNS names on that network; address and interface settings are rejected. Normalized into AppPlan.networking, with no preserved Compose copy. Attachment x-* keys remain inert metadata.";

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
  layerMerge(Schema.Array(Schema.Union([Schema.String, ComposeConfigOrSecretEntry])), REPLACE)
    .annotate({ description })
    .pipe(
      Schema.decodeTo(
        layerMerge(Schema.Array(ComposeConfigOrSecretEntry), REPLACE),
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
  "Service config grants as source-name strings or long entries; capability-checked and normalized into authored read-only file binds in ServicePlan.mounts, honoring source, target (default /<name>), and numeric or octal-string mode. Lando mounts, storage, and tmpfs take precedence; duplicate Compose volume/config destinations are rejected.";

const COMPOSE_SECRETS_DESCRIPTION =
  "Service secret grants as source-name strings or long entries; canonicalized to long entries, carried losslessly into ServicePlan.extensions.compose and capability-checked; no Lando-side activation.";

const SERVICE_CERTS_DESCRIPTION =
  "Leaf TLS certificate for this service: true issues one from the active certificate authority, false disables issuance, a path supplies a custom certificate, and an object supplies an explicit certificate and key. Separate from security.ca, which adds trusted certificate authorities.";

/** Certs input — leaf TLS toggle, custom certificate path, or explicit certificate and key pair. */
export const CertsInput = Schema.Union([
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
export type CertsInput = typeof CertsInput.Type;

const SERVICE_SECURITY_DESCRIPTION =
  "Additional CA paths and per-service overrides for inheriting host network CA and proxy settings.";

/** Trusted CA path or import reference used under `services.<name>.security.ca`. */
export const CaInput = Schema.Union([Schema.String, StringImportRef]).annotate({
  acceptsImportRef: true,
  description:
    "Trusted CA certificate as a path string or an import reference for a service security.ca entry.",
});
export type CaInput = typeof CaInput.Type;

const ServiceSecurity = Schema.Struct({
  ca: Schema.optionalKey(layerMerge(Schema.Array(CaInput), REPLACE)).annotate({
    description: "Additional CA certificate paths for this service.",
  }),
  inheritNetworkCa: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Override whether this service inherits host network CA certificates.",
  }),
  inheritNetworkProxy: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Override whether this service inherits host network proxy settings.",
  }),
});

const ServiceSecurityCaAlias = Schema.Union([CaInput, layerMerge(Schema.Array(CaInput), REPLACE)]);
const Forbidden = Schema.optionalKey(Schema.Never);

const ServiceSecurityInput = Schema.Union([
  Schema.Struct({
    ca: Schema.optionalKey(layerMerge(Schema.Array(CaInput), REPLACE)),
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
export { ServiceCreds } from "./database-connection.ts";

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
const AppMountEntry = Schema.String.check(
  Schema.makeFilter((entry) =>
    entry.startsWith("!")
      ? `Use includes: [${entry.slice(1)}] to keep ${entry.slice(1)}; \`!\` entries are not supported.`
      : undefined,
  ),
);

const AppMountObject = Schema.Struct({
  target: Schema.String.annotate({ description: "Container destination for application source." }),
  accelerate: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Allow automatic file-sync acceleration; false keeps an ordinary provider bind.",
  }),
  readOnly: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Mount application source read-only.",
  }),
  excludes: Schema.optionalKey(Schema.Array(AppMountEntry)).annotate({
    description: "Paths excluded from application source synchronization.",
  }),
  includes: Schema.optionalKey(Schema.Array(AppMountEntry)).annotate({
    description: "Excluded paths to include explicitly.",
  }),
});
const AppMountCanonical = Schema.Union([Schema.Literal(false), AppMountObject]);
const APP_MOUNT_DESCRIPTION =
  "Application source mount as a destination string or configuration object, or false to disable the app mount.";
export const AppMountInput = Schema.Union([
  Schema.String,
  Schema.Literal(false),
  AppMountObject.pipe(
    Schema.fieldsAssign({
      type: Schema.optionalKey(Schema.Never),
      source: Schema.optionalKey(Schema.Never),
    }),
  ),
])
  .annotate({
    identifier: "AppMountInput",
    description: APP_MOUNT_DESCRIPTION,
    expected: "false, a destination string, or an app-mount object",
    message: "Expected false, a destination string, or an app-mount object",
  })
  .pipe(
    Schema.decodeTo(
      AppMountCanonical,
      SchemaTransformation.transform({
        decode: (input) => (typeof input === "string" ? { target: input } : input),
        encode: (input) => input,
      }),
    ),
  )
  .annotate({ description: APP_MOUNT_DESCRIPTION });
export type AppMountInput = typeof AppMountInput.Type;

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
    user: Schema.optionalKey(ContainerUser).annotate({
      description: "Container user used to run service processes.",
    }),
    workingDirectory: Schema.optionalKey(PortablePath).annotate({
      description: "Container working directory for service processes.",
    }),
    database: Schema.optionalKey(Schema.String).annotate({
      description: "Default database, bucket, or equivalent data namespace created for the service.",
    }),
    password: Schema.optionalKey(EnvironmentValue).annotate({
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
    port: Schema.optionalKey(PortNumber).annotate({
      description: "Primary container TCP port number (integer 1-65535) exposed by the service.",
    }),
    framework: Schema.optionalKey(Schema.String),
    packageRoot: Schema.optionalKey(Schema.String).annotate({
      description:
        "App-root-relative source directory used only by service-type project-file inference; it does not change mounts or the container working directory.",
    }),
    webroot: Schema.optionalKey(PortablePath).annotate({
      description:
        "Root whose meaning and defaults are determined by the selected features: webservers use it as their document root; Ruby provides context only and does not start a server. An explicit value requires a final feature declaration of support. Relative paths resolve against the app mount. Built-in Ruby context is unavailable with appMount: false, while a webserver can still use an absolute container root without an app mount.",
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
    envFile: Schema.optionalKey(ComposeEnvFileInput),
    labels: Schema.optionalKey(ComposeLabelsInput),

    ...ComposeServiceKnobFields,

    ports: Schema.optionalKey(ComposePortsField),
    expose: Schema.optionalKey(ComposeExposeField),
    tmpfs: ComposeTmpfsServiceField,
    volumes: Schema.optionalKey(ComposeVolumesField).annotate({
      description:
        'Compose volumes as short strings ("./src:/app", "named:/data:ro", "/data") or long objects; host paths, named and anonymous volumes, and tmpfs normalize into the service mount list.',
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

    appMount: Schema.optionalKey(AppMountInput),
    mounts: Schema.optionalKey(layerMerge(Schema.Array(MountInput), REPLACE)).annotate({
      description: "Additional host or managed-file mounts attached to the service.",
    }),
    storage: Schema.optionalKey(layerMerge(Schema.Array(StorageInput), REPLACE)).annotate({
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
        "Persist the planned user's home directory when the service type knows where it is. Set path to persist a home Lando cannot infer, or false to disable home persistence.",
    }),

    scanner: Schema.optionalKey(ScannerConfig).annotate({
      description: "How the post-start URL scan probes this service, or false to skip it.",
    }),
    endpoints: Schema.optionalKey(
      layerMerge(Schema.Array(EndpointInput), keyedMerge("endpoint-name")),
    ).annotate({
      description: "Internal or published network endpoints exposed by the service.",
    }),
    routes: Schema.optionalKey(layerMerge(Schema.Array(RouteInput), ROUTE_MERGE)).annotate({
      description:
        "Hostnames routed to service endpoints. An empty list disables the generated default route.",
    }),

    healthcheck: Schema.optionalKey(HealthcheckInput),
    readiness: Schema.optionalKey(HealthcheckInput).annotate({
      description:
        "Lifecycle readiness probe, independent of native healthcheck; false explicitly disables command readiness, not process supervision.",
    }),
    logs: Schema.optionalKey(layerMerge(Schema.Array(LogSourceInput), keyedMerge("log-id"))),
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
      layerMerge(
        Schema.Union([
          layerMerge(Schema.Array(Schema.String), DEPENDENCY_MERGE),
          layerMerge(ServiceDependencyInputRecord, DEPENDENCY_MERGE),
        ]),
        DEPENDENCY_MERGE,
      ),
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
export const SERVICE_CONFIG_ALIASES = [
  ["working_dir", "workingDirectory"],
  ["env_file", "envFile"],
  ["depends_on", "dependsOn"],
] as const;

const ServiceConfigDecode = ServiceConfigInput.pipe(
  Schema.decodeTo(
    ServiceConfig,
    SchemaTransformation.transformEffect({
      decode: (input) => {
        const canonical: Record<string, unknown> = { ...input };
        for (const [alias, key] of SERVICE_CONFIG_ALIASES) {
          if (!Object.hasOwn(input, key) && Object.hasOwn(input, alias)) canonical[key] = input[alias];
          delete canonical[alias];
        }
        return Effect.succeed(canonical);
      },
      encode: (encoded) => Effect.succeed(encoded),
    }),
  ),
);

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
  service: Schema.optionalKey(Schema.String).annotate({
    description: "Service target, :host for host execution, or :<flag-name> for a dynamic target.",
  }),
  description: Schema.optionalKey(Schema.String).annotate({ description: "Task description shown in help." }),
  summary: Schema.optionalKey(Schema.String).annotate({
    description: "Short task help, used when description is absent.",
  }),
  cmd: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
    description: "Single shell command or argv array run by the task.",
  }),
  cmds: Schema.optionalKey(
    layerMerge(Schema.Array(Schema.Union([Schema.String, ToolingStepShape])), REPLACE),
  ).annotate({
    description: "Ordered shell commands or command steps with task-local execution overrides.",
  }),
  ...ToolingAuthoredInputFields,
  dir: Schema.optionalKey(PortablePath).annotate({
    description: "Working directory used when the tooling task runs.",
  }),
  env: Schema.optionalKey(ToolingEnvironment).annotate({
    description: "Environment variables applied to this tooling task after app-wide tooling defaults.",
  }),
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVar)).annotate({
    description: "Task-local variables, overriding include and app-wide tooling variables.",
  }),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type ToolingTaskShape = typeof ToolingTaskShape.Type;

const TOOLING_TASK_FORMS = {
  expected: "false, a non-empty command string, or a tooling task object",
  message: "Expected false, a non-empty command string, or a tooling task object",
};
const ToolingTaskShorthand = Schema.Union([
  Schema.Literal(false),
  Schema.String.check(
    Schema.isMinLength(toolingTaskStringConstraints.minLength, {
      message: "Expected a non-empty command string; use false to disable a task",
    }),
    Schema.makeFilter((input) => input !== toolingTaskStringConstraints.not.const, {
      message: "`disabled` is not a command; use false to disable a task",
      toJsonSchema: () => ({ not: toolingTaskStringConstraints.not }),
    }),
  ),
])
  .annotate(TOOLING_TASK_FORMS)
  .pipe(
    Schema.decodeTo(
      Schema.toType(ToolingTaskShape),
      SchemaTransformation.transformEffect({
        decode: (input): Effect.Effect<ToolingTaskShape, SchemaIssue.Issue> =>
          Effect.succeed(input === false ? { disabled: true } : { cmd: input }),
        // Task objects encode through the object member, which the union tries first.
        encode: (): Effect.Effect<string | false, SchemaIssue.Issue> =>
          Effect.fail(new SchemaIssue.Forbidden({ message: "Tooling tasks encode as objects" })),
      }),
    ),
  );

// The object member stays outside the shorthand codec so authoring derivation walks the
// task struct itself and keeps its nested checks instead of a flattened encoded copy.
export const ToolingTaskInput = Schema.Union([ToolingTaskShape, ToolingTaskShorthand]).annotate({
  identifier: "ToolingTaskInput",
  description:
    "Tooling task object or non-empty command string; false disables the task. Shorthands replace inherited tasks after layer composition.",
  ...TOOLING_TASK_FORMS,
});
export type ToolingTaskInput = typeof ToolingTaskInput.Type;

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
 * - `service:` — literal service target, defaulting to `:host` when omitted.
 * - `desc:` / `description:` / `summary:` — short help text. `desc` is
 *   accepted as an alias for `description` by script-backed tooling.
 * - `flags:` / `args:` / `disabled:` — shared tooling input declarations and visibility.
 *
 * Unsupported fields (`aliases`, `topLevelAlias`, `bootstrap`,
 * `passThrough`, `sources`, `generates`, `status`,
 * `preconditions`, `run`, `platforms`, `internal`,
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
  ...ToolingAuthoredInputFields,
  disabled: Schema.optionalKey(Schema.Boolean),
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
  includes: Schema.optionalKey(layerMerge(Schema.Array(IncludeEntry), REPLACE)),
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
  proxy: Schema.optionalKey(Schema.Record(ServiceName, layerMerge(Schema.Array(RouteInput), ROUTE_MERGE))),
  router: Schema.optionalKey(RouterConfig).annotate({
    description: "App-authored shared-router bind address and port policy.",
  }),
  providers: Schema.optionalKey(ProviderExtensionConfig),
  toolingDefaults: Schema.optionalKey(ToolingDefaultsShape).annotate({
    description: "App-wide service, directory, environment, and variable defaults for tooling tasks.",
  }),
  tooling: Schema.optionalKey(Schema.Record(Schema.String, ToolingTaskInput)),
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

export const defineLandofile = <T extends import("./landofile-overlay.ts").LandofileOverlayInput>(
  value: T,
): T => value;
