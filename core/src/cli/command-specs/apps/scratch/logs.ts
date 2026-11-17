import { LogsAppResult } from "@lando/engine/operations/logs";
import { StreamFrame } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  followScratchLogs,
  renderScratchLogsResult,
  scratchIdFromInput,
  scratchLogs,
} from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { Args, Flags } from "../../../spec/metadata";
import {
  logFollowFromInput,
  logLinesToStreamFrames,
  logOptionsFromInput,
  logSignalFromInput,
  redactLogLineStreams,
} from "../../logs-input";

export const scratchLogsOptionsFromInput = (input: unknown): Parameters<typeof scratchLogs>[1] =>
  logOptionsFromInput(input);

export const scratchLogsFollowFromInput = (input: unknown): boolean => logFollowFromInput(input);

export const appsScratchLogsSpec: LandoCommandSpec<LogsAppResult> = {
  resultSchema: LogsAppResult,
  id: "apps:scratch:logs",
  summary: "Show logs for a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: "scratch:logs",
  aliases: ["scratch:logs"],
  bootstrap: "scratch",
  args: {
    id: Args.string({ description: "Scratch app id.", required: false }),
  },
  streaming: StreamFrame,
  streamingMode: (input) => (scratchLogsFollowFromInput(input) ? "live" : undefined),
  flags: {
    service: Flags.string({ char: "s", description: "Filter logs to a single scratch service." }),
    follow: Flags.boolean({ char: "f", description: "Stream new log lines until interrupted." }),
    tail: Flags.integer({ description: "Show last N lines per service." }),
    since: Flags.string({
      description: "Only show logs since a duration (e.g. 30s, 15m, 2h) or an RFC3339 timestamp.",
    }),
  },
  run: (input) => {
    const options = scratchLogsOptionsFromInput(input);
    if (!scratchLogsFollowFromInput(input))
      return scratchLogs(scratchIdFromInput(input), options).pipe(Effect.flatMap(redactLogLineStreams));
    const signal = logSignalFromInput(input);
    return followScratchLogs(scratchIdFromInput(input), {
      ...options,
      follow: true,
      ...(signal === undefined ? {} : { signal }),
    });
  },
  streamFrames: logLinesToStreamFrames,
  render: (result) => renderScratchLogsResult(result),
};
