import { Effect, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { type GlobalConfig, type NotifyConfig, NotifyConfig as NotifyConfigSchema } from "@lando/sdk/schema";

const DEFAULT_NOTIFY_CONFIG = Schema.decodeSync(NotifyConfigSchema)({});

export const resolveNotifyConfig = (
  config: GlobalConfig,
  commandIds: ReadonlySet<string>,
): Effect.Effect<NotifyConfig, ConfigError> => {
  const notify = config.notify ?? DEFAULT_NOTIFY_CONFIG;
  const unknownIndex = notify.commands.findIndex((commandId) => !commandIds.has(commandId));
  if (unknownIndex < 0) return Effect.succeed(notify);
  const commandId = notify.commands[unknownIndex];
  return Effect.fail(
    new ConfigError({
      path: `notify.commands[${unknownIndex}]`,
      message: `Unknown or ineligible canonical command id "${commandId}" in notify.commands. Remove it, install and enable the plugin that contributes it, or choose a commands-tier-or-higher command.`,
    }),
  );
};
