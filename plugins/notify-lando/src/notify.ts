import { Effect, Schema } from "effect";

import { CliCommandErrorEvent, CliCommandRunEvent } from "@lando/sdk/events";
import type { LandoEvent } from "@lando/sdk/events";
import type { SubscriberFactory } from "@lando/sdk/plugins";
import type { NotifyConfig } from "@lando/sdk/schema";

export const DEFAULT_NOTIFY_COMMAND_IDS = [
  "app:start",
  "app:stop",
  "app:restart",
  "app:rebuild",
  "app:destroy",
  "meta:setup",
  "meta:update",
] as const;

export const resolveNotifyCommandIds = (config: NotifyConfig): ReadonlyArray<string> => {
  const ids: string[] = [...DEFAULT_NOTIFY_COMMAND_IDS];
  for (const commandId of config.commands) {
    if (!ids.includes(commandId)) ids.push(commandId);
  }
  return ids;
};

type Terminal =
  | { readonly kind: "success"; readonly event: CliCommandRunEvent }
  | { readonly kind: "failure"; readonly event: CliCommandErrorEvent };

const terminalFrom = (event: LandoEvent): Terminal | undefined => {
  if (Schema.is(CliCommandRunEvent)(event)) return { kind: "success", event };
  if (Schema.is(CliCommandErrorEvent)(event)) return { kind: "failure", event };
  return undefined;
};

const notify: SubscriberFactory<NotifyConfig> = (ctx, config) => {
  if (!config.enabled) return () => Effect.void;
  const eligible = resolveNotifyCommandIds(config);
  return (event) => {
    const terminal = terminalFrom(event);
    if (
      terminal === undefined ||
      terminal.event.parentInvocationId !== undefined ||
      terminal.event.durationMs < config.thresholdMs ||
      !eligible.includes(terminal.event.commandId)
    ) {
      return Effect.void;
    }
    switch (terminal.kind) {
      case "success":
        return ctx.events.publishRender({
          _tag: "notify.desktop",
          title: `Lando ${terminal.event.commandId} completed`,
          body: `Completed in ${terminal.event.durationMs}ms.`,
          urgency: "success",
        });
      case "failure":
        return ctx.events.publishRender({
          _tag: "notify.desktop",
          title: `Lando ${terminal.event.commandId} failed`,
          body: `Failed in ${terminal.event.durationMs}ms (${terminal.event.failureTag}).`,
          urgency: "failure",
        });
    }
  };
};

export default notify;
