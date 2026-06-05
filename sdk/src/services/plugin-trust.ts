import { Context, type Effect } from "effect";

import type { ConfigError } from "../errors/index.ts";

export interface PluginTrustState {
  readonly trustedPlugins: ReadonlyArray<string>;
  readonly trustedAuthoringRoots: ReadonlyArray<string>;
}

export class PluginTrustStore extends Context.Tag("@lando/core/PluginTrustStore")<
  PluginTrustStore,
  {
    readonly read: Effect.Effect<PluginTrustState, ConfigError>;
    readonly isPluginTrusted: (name: string) => Effect.Effect<boolean, ConfigError>;
    readonly trustPlugin: (name: string) => Effect.Effect<void, ConfigError>;
    readonly untrustPlugin: (name: string) => Effect.Effect<void, ConfigError>;
    readonly isAuthoringRootTrusted: (path: string) => Effect.Effect<boolean, ConfigError>;
    readonly trustAuthoringRoot: (path: string) => Effect.Effect<void, ConfigError>;
  }
>() {}
