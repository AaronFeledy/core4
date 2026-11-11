import { LogsAppResult, followLogsApp, logsApp } from "@lando/engine/operations/logs";
import { buildLogsApp } from "@lando/engine/operations/logs-build";
import { StreamFrame } from "@lando/sdk/schema";
import { Effect } from "effect";
import { renderLogsAppResult } from "../../commands/logs";
import type { LandoCommandSpec } from "../../spec/command-base";
import { specFlagsOf, stringFlag } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";
import {
  logBuildConflictFromInput,
  logBuildFromInput,
  logFollowFromInput,
  logLinesToStreamFrames,
  logOptionsFromInput,
  logSignalFromInput,
} from "../logs-input";

export interface LogsFlags {
  readonly service?: string;
  readonly build?: boolean;
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
  resultSchema: LogsAppResult,
  id: "app:logs",
  helpGroup: "common",
  mcpAllowed: true,
  summary: "Stream logs from the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  usage: "[--service SERVICE] [--build]",
  flags: {
    service: Flags.string({ char: "s", description: "Filter logs to a single planned service." }),
    build: Flags.boolean({
      description: "Show the output of the most recent build instead of service logs.",
    }),
    follow: Flags.boolean({ char: "f", description: "Stream new log lines until interrupted." }),
    tail: Flags.integer({ description: "Show last N lines per service." }),
    since: Flags.string({
      description: "Only show logs since a duration (e.g. 30s, 15m, 2h) or an RFC3339 timestamp.",
    }),
    source: Flags.string({
      description:
        "Select a declared source id, or `console` for all container logs. Console aliases and redirects select a native stdout/stderr pipe; aliases on the same pipe share its logs.",
    }),
    "no-viewer": Flags.boolean({
      description:
        "Reserved for the interactive log viewer; accepted as a no-op until the viewer exists (does not change follow behavior).",
      default: false,
    }),
  },
  streaming: StreamFrame,
  streamingMode: (input) => (logsFollowFromInput(input) ? "live" : undefined),
  run: (input) => {
    const conflict = logBuildConflictFromInput(input);
    if (conflict !== undefined) return Effect.fail(conflict);
    if (logBuildFromInput(input)) {
      const options = logOptionsFromInput(input);
      return buildLogsApp({
        ...(options.service === undefined ? {} : { service: options.service }),
        ...(options.tail === undefined ? {} : { tail: options.tail }),
      });
    }
    const options = logsOptionsFromInput(input);
    if (!logsFollowFromInput(input)) return logsApp(options);
    const signal = logSignalFromInput(input);
    return followLogsApp({ ...options, follow: true, ...(signal === undefined ? {} : { signal }) });
  },
  streamFrames: logLinesToStreamFrames,
  render: renderLogsAppResult,
};
