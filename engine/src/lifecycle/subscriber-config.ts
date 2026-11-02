import { Effect, Schema } from "effect";

import { type GlobalConfig, type NotifyConfig, NotifyConfig as NotifyConfigSchema } from "@lando/sdk/schema";

const DEFAULT_NOTIFY_CONFIG = Schema.decodeSync(NotifyConfigSchema)({});

export const resolveNotifyConfig = (config: GlobalConfig): Effect.Effect<NotifyConfig> => {
  const notify = config.notify ?? DEFAULT_NOTIFY_CONFIG;
  return Effect.succeed(notify);
};
