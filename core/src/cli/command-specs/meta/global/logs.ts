import { Flags } from "../../../spec/metadata";

import { LogsAppResult } from "@lando/engine/operations/logs";
import { StreamFrame } from "@lando/sdk/schema";

import {
  type GlobalLogsResult,
  followGlobalLogs,
  globalLogs,
  renderGlobalLogsResult,
} from "../../../commands/meta/global-logs";
import type { LandoCommandSpec } from "../../../spec/command-base";
import {
  logFollowFromInput,
  logLinesToStreamFrames,
  logOptionsFromInput,
  logSignalFromInput,
} from "../../logs-input";

export interface GlobalLogsFlags {
  readonly service?: string;
  readonly follow?: boolean;
  readonly tail?: number;
  readonly since?: string;
}

export const globalLogsOptionsFromInput = (input: unknown): Parameters<typeof globalLogs>[0] =>
  logOptionsFromInput(input);

export const globalLogsFollowFromInput = (input: unknown): boolean => logFollowFromInput(input);

export const globalLogsSpec: LandoCommandSpec<GlobalLogsResult> = {
  resultSchema: LogsAppResult,
  id: "meta:global:logs",
  summary: "Stream logs from the host-level global Lando app.",
  description: "Stream logs from the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:logs",
  bootstrap: "global",
  streaming: StreamFrame,
  streamingMode: (input) => (globalLogsFollowFromInput(input) ? "live" : undefined),
  flags: {
    service: Flags.string({ char: "s", description: "Filter logs to a single global service." }),
    follow: Flags.boolean({ char: "f", description: "Stream new log lines until interrupted." }),
    tail: Flags.integer({ description: "Show last N lines per service." }),
    since: Flags.string({
      description: "Only show logs since a duration (e.g. 30s, 15m, 2h) or an RFC3339 timestamp.",
    }),
  },
  run: (input) => {
    const options = globalLogsOptionsFromInput(input);
    if (!globalLogsFollowFromInput(input)) return globalLogs(options);
    const signal = logSignalFromInput(input);
    return followGlobalLogs({ ...options, follow: true, ...(signal === undefined ? {} : { signal }) });
  },
  streamFrames: logLinesToStreamFrames,
  render: renderGlobalLogsResult,
};
