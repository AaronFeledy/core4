import { Context, type Effect, type Schema } from "effect";

import type { PluginLoadError, PluginManifestError, ServiceTypeError } from "../errors/index.ts";
import type {
  PlanMetadata,
  PluginManifest,
  ProviderId,
  ServiceConfig,
  ToolingTaskShape,
} from "../schema/index.ts";

export class PluginRegistry extends Context.Tag("@lando/core/PluginRegistry")<
  PluginRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<PluginManifest>, PluginManifestError>;
    readonly load: (name: string) => Effect.Effect<PluginManifest, PluginLoadError | PluginManifestError>;
    readonly loadServiceType: (
      id: string,
    ) => Effect.Effect<ServiceType, PluginLoadError | PluginManifestError>;
  }
>() {}

/** Host identity facts a service type may read while resolving config. */
export interface ServiceTypeHostFacts {
  readonly os: string;
  readonly user: string;
  readonly uid: string;
  readonly gid: string;
  readonly home: string;
}

/** Input handed to {@link ServiceType.resolve} for one service in the resolved Landofile. */
export interface ServiceTypeInput {
  readonly name: string;
  readonly service: ServiceConfig;
  readonly appRoot: string;
  readonly appName?: string;
  readonly provider?: ProviderId;
  readonly primary?: boolean;
  readonly metadata: typeof PlanMetadata.Encoded;
  readonly host?: ServiceTypeHostFacts | undefined;
}

/**
 * A reference to a composable feature the planner applies to the seeded base
 * draft in priority order. `config` carries the feature's resolved
 * options; the planner reads the feature's priority from its definition.
 */
export interface FeatureRef {
  readonly id: string;
  readonly config?: Record<string, unknown>;
}

/**
 * The output of {@link ServiceType.resolve}: normalized config plus the
 * priority-ordered features core composes onto the named base.
 * A service type MUST NOT hand-build a `ServicePlan`.
 */
export interface ServiceTypeResolution {
  readonly base: "l337" | "lando";
  readonly normalizedConfig: ServiceConfig;
  readonly features: ReadonlyArray<FeatureRef>;
  readonly tooling?: Readonly<Record<string, ToolingTaskShape>>;
  readonly metadata?: Record<string, unknown>;
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
  readonly schema: Schema.Schema<unknown>;
  readonly resolve: (input: ServiceTypeInput) => Effect.Effect<ServiceTypeResolution, ServiceTypeError>;
}

export interface RegisteredCommand {
  readonly id: string;
  readonly summary: string;
  readonly hidden: boolean;
}

export class CommandRegistry extends Context.Tag("@lando/core/CommandRegistry")<
  CommandRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<RegisteredCommand>, never>;
  }
>() {}
