import { Context, type Effect } from "effect";

import type { ConfigError } from "../errors/index.ts";
import type { GlobalConfig } from "../schema/index.ts";

export class ConfigService extends Context.Tag("@lando/core/ConfigService")<
  ConfigService,
  {
    readonly load: Effect.Effect<GlobalConfig, ConfigError>;
    readonly get: <K extends keyof GlobalConfig>(key: K) => Effect.Effect<GlobalConfig[K], ConfigError>;
  }
>() {}
