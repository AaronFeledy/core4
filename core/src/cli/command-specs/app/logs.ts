import { Flags } from "../../spec/metadata";

import { StreamFrame } from "@lando/sdk/schema";

import { type LogsAppResult, followLogsApp, logsApp } from "@lando/engine/operations/logs";
import { renderLogsAppResult } from "../../commands/logs";
import { EmptyResultSchema, type LandoCommandSpec } from "../../spec/command-base";
import { specFlagsOf, stringFlag } from "../../spec/input-coercion";
import {
  logFollowFromInput,
  logLinesToStreamFrames,
  logOptionsFromInput,
  logSignalFromInput,
} from "../logs-input";

export interface LogsFlags {
  readonly service?: string;
  readonly follow?: boolean;
  readonly tail?: number;
  readonly since?: string;
  readonly source?: string;
  /**
   * Reserved for the interactive log viewer. Accepted as a no-op today so
   * scripts can pass the flag early without breaking.
   */
  readonly "no-viewer"?: boolean;
}

export const logsOptionsFromInput = (input: unknown): Parameters<typeof logsApp>[0] => {
  const source = stringFlag(specFlagsOf(input), "source");
  return {
    ...logOptionsFromInput(input),
    ...(source === undefined ? {} : { source }),
  };
};

export const logsFollowFromInput = (input: unknown): boolean => logFollowFromInput(input);

export const logsSpec: LandoCommandSpec<LogsAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:logs",
  helpGroup: "common",
  mcpAllowed: true,
  summary: "Stream logs from the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  usage: "[--service SERVICE]",
  flags: {
    service: Flags.string({ char: "s", description: "Filter logs to a single planned service." }),
    follow: Flags.boolean({ char: "f", description: "Stream new log lines until interrupted." }),
    tail: Flags.integer({ description: "Show last N lines per service." }),
    since: Flags.string({
      description: "Only show logs since a duration (e.g. 30s, 15m, 2h) or an RFC3339 timestamp.",
    }),
    source: Flags.string({
      description:
        "Select a declared source id, or `console` for the container stream. Redirected sources share that stdout/stderr stream and cannot be isolated.",
    }),
    "no-viewer": Flags.boolean({
      description:
        "Reserved for the 4.1 interactive log viewer; accepted as a no-op in 4.0 (does not change follow behavior).",
      default: false,
    }),
  },
  streaming: StreamFrame,
  streamingMode: (input) => (logsFollowFromInput(input) ? "live" : undefined),
  run: (input) => {
    const options = logsOptionsFromInput(input);
    if (!logsFollowFromInput(input)) return logsApp(options);
    const signal = logSignalFromInput(input);
    return followLogsApp({ ...options, follow: true, ...(signal === undefined ? {} : { signal }) });
  },
  streamFrames: (value) => {
    const result = value as LogsAppResult;
    return logLinesToStreamFrames(result);
  },
  render: (result) => renderLogsAppResult(result as LogsAppResult),
};
