import { Effect, Layer } from "effect";

import type { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

const load = Effect.succeed({} as GlobalConfig);

export const emptyConfigServiceLayer: Layer.Layer<ConfigService> = Layer.succeed(ConfigService, {
  load,
  get: <K extends keyof GlobalConfig>(key: K) => Effect.map(load, (loaded): GlobalConfig[K] => loaded[key]),
});
