import { Context, type Effect } from "effect";

import type { GlobalConfig } from "../schema/index.ts";

export class ConfigService extends Context.Service<
  ConfigService,
  {
    readonly load: Effect.Effect<GlobalConfig>;
    readonly get: <K extends keyof GlobalConfig>(key: K) => Effect.Effect<GlobalConfig[K]>;
  }
>()("@lando/core/ConfigService") {}
