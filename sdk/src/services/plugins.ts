import { Context, type Effect } from "effect";

import type { PluginLoadError, PluginManifestError } from "../errors/index.ts";
import type {
  PlanMetadata,
  PluginManifest,
  ProviderId,
  ServiceConfig,
  ServicePlan,
} from "../schema/index.ts";

export class PluginRegistry extends Context.Tag("@lando/core/PluginRegistry")<
  PluginRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<PluginManifest>, PluginManifestError>;
    readonly load: (name: string) => Effect.Effect<PluginManifest, PluginLoadError | PluginManifestError>;
    readonly loadServiceType: (
      id: string,
    ) => Effect.Effect<ServiceTypeShape, PluginLoadError | PluginManifestError>;
  }
>() {}

export interface ServiceTypeHostFacts {
  readonly os: string;
  readonly user: string;
  readonly uid: string;
  readonly gid: string;
  readonly home: string;
}

export interface ServiceTypePlanInput {
  readonly name: string;
  readonly service: ServiceConfig;
  readonly appRoot: string;
  readonly appName?: string;
  readonly provider?: ProviderId;
  readonly primary?: boolean;
  readonly metadata: typeof PlanMetadata.Encoded;
  readonly host?: ServiceTypeHostFacts | undefined;
}

export interface ServiceTypeShape {
  readonly id: string;
  readonly toServicePlan: (input: ServiceTypePlanInput) => ServicePlan;
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
