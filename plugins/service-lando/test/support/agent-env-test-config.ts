import { Effect, Layer } from "effect";

import type { AgentEnvConfig, GlobalConfig } from "@lando/core/schema";
import { ConfigService } from "@lando/core/services";

export const configServiceLayer = (config: GlobalConfig): Layer.Layer<ConfigService> => {
  const load = Effect.succeed(config);
  return Layer.succeed(ConfigService, {
    load,
    get: <K extends keyof GlobalConfig>(key: K) => Effect.map(load, (loaded): GlobalConfig[K] => loaded[key]),
  });
};

export const emptyConfigServiceLayer: Layer.Layer<ConfigService> = configServiceLayer({} as GlobalConfig);

export const agentEnvConfigServiceLayer = (agentEnv: AgentEnvConfig): Layer.Layer<ConfigService> =>
  configServiceLayer({ agentEnv } as GlobalConfig);
