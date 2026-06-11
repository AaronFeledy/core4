import { Context, type Effect } from "effect";

import type { ConfigError } from "../errors/index.ts";
import type { PluginTrustState } from "../schema/index.ts";
export type { PluginTrustState } from "../schema/index.ts";

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
