import { Context, type Effect, type Schema } from "effect";

import type {
  PluginLoadError,
  PluginManifestError,
  ServiceTypeCollisionError,
  ServiceTypeError,
} from "../errors/index.ts";
import type {
  AbsoluteContainerPath,
  ContainerUser,
  DatabaseConnection,
  HostPlatform,
  LogSource,
  PlanMetadata,
  PluginManifest,
  PortNumber,
  ProviderCapabilities,
  ProviderId,
  ServiceConfig,
  ServiceCreds,
  ServiceName,
  ServiceProjectUser,
  ToolingTaskShape,
} from "../schema/index.ts";
import type { RegisteredCommand } from "../schema/registered-command.ts";
import type { GeneratedCertificateEndpoint } from "../schema/service-resolution.ts";
import type { AppFeatureDefinition } from "./app-features.ts";
import type { ServiceFeatureDefinition } from "./features.ts";

export type { RegisteredCommand } from "../schema/registered-command.ts";

export class PluginRegistry extends Context.Service<
  PluginRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<PluginManifest>, PluginManifestError>;
    /**
     * A provider's capabilities declared offline for the given host, without constructing the provider.
     * Undefined when the provider contributes no offline declaration.
     */
    readonly declaredProviderCapabilities?: (
      id: ProviderId,
      platform: HostPlatform,
    ) => ProviderCapabilities | undefined;
    readonly load: (name: string) => Effect.Effect<PluginManifest, PluginLoadError | PluginManifestError>;
    readonly loadServiceType: (
      id: string,
    ) => Effect.Effect<ServiceType, PluginLoadError | PluginManifestError | ServiceTypeCollisionError>;
    readonly loadServiceFeature: (
      id: string,
    ) => Effect.Effect<ServiceFeatureDefinition, PluginLoadError | PluginManifestError>;
    readonly loadAppFeature: (
      id: string,
    ) => Effect.Effect<AppFeatureDefinition, PluginLoadError | PluginManifestError>;
  }
>()("@lando/core/PluginRegistry") {}

/** Host identity facts a service type may read while resolving config. */
export interface ServiceTypeHostFacts {
  readonly os: string;
  readonly user: string;
  readonly uid: string;
  readonly gid: string;
  readonly home: string;
  readonly arch: string;
}

/** One bounded app-root-relative file a service type asks the planner to read. */
export interface ServiceTypeProjectFileDeclaration {
  readonly path: string;
  readonly maxBytes: number;
}

/** Planner-supplied file state. Missing files are retained so cache keys track creation and deletion. */
export type ServiceTypeProjectFileInput =
  | {
      readonly path: string;
      readonly present: false;
    }
  | {
      readonly path: string;
      readonly present: true;
      readonly text: string;
      readonly sha256: string;
    };

/** Input handed to {@link ServiceType.resolve} for one service in the resolved Landofile. */
export interface ServiceTypeInput {
  readonly name: string;
  readonly service: ServiceConfig;
  readonly appRoot: string;
  readonly appName?: string;
  /** Derive persisted defaults (databases, passwords, buckets) from this name so they survive a rename. Defaults to appName. */
  readonly dataName?: string;
  readonly provider?: ProviderId;
  readonly primary?: boolean;
  readonly metadata: typeof PlanMetadata.Encoded;
  readonly host?: ServiceTypeHostFacts | undefined;
  readonly capabilities?: ProviderCapabilities;
  readonly projectFiles?: ReadonlyArray<ServiceTypeProjectFileInput>;
  readonly parentResolution?: ServiceTypeResolution | undefined;
}

/**
 * A reference to a composable feature the planner applies to the seeded base
 * draft in priority order. `config` carries the feature's resolved
 * options; the planner reads the feature's priority from its definition.
 * Service-field support is declared explicitly by the feature definition's
 * `validateEffective` result, never inferred from keys in this config. Validation
 * sees Original decoded config and final inherited immutable facts before cache
 * lookup, including when authored endpoints replace discovery. Claims name only
 * fields the feature actually represents; findings use ServiceFeatureError.issues.
 */
export interface FeatureRef {
  readonly id: string;
  readonly config?: Record<string, unknown>;
}

import type { ServiceLaunchers as ServiceLaunchersTable } from "../schema/service-launchers.ts";
import {
  ServiceLauncherMarker as ServiceLauncherMarkerSchema,
  ServiceLaunchers as ServiceLaunchersSchema,
} from "../schema/service-launchers.ts";

export const ServiceLauncherMarker = ServiceLauncherMarkerSchema;
export const ServiceLaunchers = ServiceLaunchersSchema;
export type ServiceLaunchers = ServiceLaunchersTable;

/**
 * The output of {@link ServiceType.resolve}: normalized config plus the
 * priority-ordered features core composes onto the named base.
 * A service type MUST NOT hand-build a `ServicePlan`.
 */
export interface ServiceTypeResolution {
  readonly launchers?: ServiceLaunchersTable;
  readonly connection?: DatabaseConnection;
  readonly nonSqlCreds?: ServiceCreds;
  readonly base: "l337" | "lando";
  readonly normalizedConfig: ServiceConfig;
  readonly features: ReadonlyArray<FeatureRef>;
  readonly logSources?: ReadonlyArray<LogSource>;
  /**
   * Tooling tasks contributed by this service type. In the final task map,
   * task, include, and recipe values win while app defaults fill missing
   * service/directory values and merge below environment/variable keys.
   */
  readonly tooling?: Readonly<Record<string, ToolingTaskShape>>;
  /**
   * Generated connection-client task names. Omission seeds from this declaration's
   * own factory; an explicit array suppresses seeding. Inheritance retains parent
   * claims except tasks explicitly contributed by a child, unless reauthorized.
   * Composed resolutions always carry an explicit array, including empty claims.
   */
  readonly connectionClientNames?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  /**
   * The owned launcher's generated HTTPS listener, when it can serve the
   * service's own generated certificate. The resolver reports it for every
   * Lando-owned launcher, including one whose authored `user:` cannot read the
   * generated key, so route planning can explain that opt-out. It declares a
   * port, not a certificate request: the demand phase requires a root parent and
   * activates the association only for a materialized generated certificate and
   * an HTTPS route that actually selects this port.
   */
  readonly generatedCertificateEndpoint?: GeneratedCertificateEndpoint;
}

/**
 * What a service type knows about the identities inside the image it ships.
 * Planning reads this to place the planned user's home on a persistent store
 * without guessing a path. It describes the type's OWN image only: a service
 * that supplies its own `image:` or Compose `build:` is a custom image and this
 * metadata no longer applies to it.
 */
export interface ServiceImageIdentity {
  /** The identity the image runs as when the Landofile names none. */
  readonly defaultUser: ContainerUser;
  /** Home directory per user principal, keyed without any `:group` suffix. */
  readonly homes: Readonly<Record<string, AbsoluteContainerPath>>;
  /**
   * The identity that owns files this image's service creates on a provider
   * that maps one container id to the host user. Omitted when the image
   * ships no such principal.
   */
  readonly projectUser?: ServiceProjectUser;
  /** Use the implicit catalog account only with the generated launcher. */
  readonly projectUserDefault?: "launcher";
  /** Principals whose passwd home the image does not create or give to that user.
   * Lando creates and owns it in a root build step so a fresh home store seeds correctly. */
  readonly preparedHomes?: ReadonlyArray<string>;
}

/**
 * Normative service-type contract: a resolver that turns
 * `type: <name>` into a {@link ServiceTypeResolution} of normalized config plus
 * the features to compose onto a declared `base`. It chooses base/features/
 * tooling; it does NOT build the plan (that is core's composition pipeline).
 */
export interface ServiceType {
  readonly id: string;
  readonly name: string;
  readonly base: "l337" | "lando";
  readonly versions?: ReadonlyArray<string>;
  readonly extends?: string;
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly identity?: ServiceImageIdentity;
  readonly toolingForConnection?: (
    name: ServiceName,
    connection: DatabaseConnection,
  ) => Readonly<Record<string, ToolingTaskShape>>;
  readonly projectFiles?: (service: ServiceConfig) => ReadonlyArray<ServiceTypeProjectFileDeclaration>;
  /** User guidance when this configuration has no launcher that accepts extraArgs. */
  readonly extraArgsRemediation?: string | ((config: ServiceConfig) => string);
  /** Pure selection of the container port for service.port, independent of endpoint declarations. */
  readonly plannedPort?: (
    service: Pick<ServiceConfig, "port" | "framework" | "via" | "type">,
  ) => PortNumber | undefined;
  readonly schema: Schema.Codec<unknown, unknown>;
  readonly resolve: (input: ServiceTypeInput) => Effect.Effect<ServiceTypeResolution, ServiceTypeError>;
}

export class CommandRegistry extends Context.Service<
  CommandRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<RegisteredCommand>, never>;
  }
>()("@lando/core/CommandRegistry") {}
