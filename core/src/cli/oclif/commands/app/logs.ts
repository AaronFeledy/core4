import { Flags } from "@oclif/core";

import { StreamFrame } from "@lando/sdk/schema";

import { type LogsAppResult, followLogsApp, logsApp, renderLogsAppResult } from "../../../commands/logs.ts";
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../command-base.ts";

export interface LogsFlags {
  readonly service?: string;
  readonly follow?: boolean;
  readonly tail?: number;
  readonly since?: string;
  readonly source?: string;
}

const flagsFromInput = (input: unknown): LogsFlags =>
  typeof input === "object" && input !== null ? ((input as { readonly flags?: LogsFlags }).flags ?? {}) : {};

export const logsOptionsFromInput = (input: unknown): Parameters<typeof logsApp>[0] => {
  const flags = flagsFromInput(input);
  return {
    ...(flags.service === undefined ? {} : { service: flags.service }),
    ...(flags.tail === undefined ? {} : { tail: flags.tail }),
    ...(flags.since === undefined ? {} : { since: flags.since }),
    ...(flags.source === undefined ? {} : { source: flags.source }),
  };
};

export const logsFollowFromInput = (input: unknown): boolean => flagsFromInput(input).follow === true;

const signalFromInput = (input: unknown): AbortSignal | undefined =>
  typeof input === "object" && input !== null
    ? (input as { readonly signal?: AbortSignal }).signal
    : undefined;

export const logsSpec: LandoCommandSpec<LogsAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:logs",
  mcpAllowed: true,
  summary: "Stream logs from the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  streaming: StreamFrame,
  run: (input) => {
    const options = logsOptionsFromInput(input);
    if (!logsFollowFromInput(input)) return logsApp(options);
    const signal = signalFromInput(input);
    return followLogsApp({ ...options, follow: true, ...(signal === undefined ? {} : { signal }) });
  },
  streamFrames: (value) => {
    const result = value as LogsAppResult;
    return result.lines.map((line) => ({
      _tag: line.stream,
      service: line.service,
      chunk: `${line.line}\n`,
      ...(line.source === undefined ? {} : { source: line.source }),
    }));
  },
  render: (result) => renderLogsAppResult(result as LogsAppResult),
};

// Type intentionally left inferred: an explicit `LandoCommandSpec` annotation makes the
// machine-output gate read this spread variant as a spec missing a literal `resultSchema`.
const followLogsSpec = { ...logsSpec, streamingMode: "live" as const };

export default class LogsCommand extends LandoCommandBase {
  static override description = logsSpec.summary;
  static override aliases = [...resolveTopLevelAliases(logsSpec)];
  static override flags = {
    service: Flags.string({ char: "s", description: "Filter logs to a single planned service." }),
    follow: Flags.boolean({ char: "f", description: "Stream new log lines until interrupted." }),
    tail: Flags.integer({ description: "Show last N lines per service." }),
    since: Flags.string({
      description: "Only show logs since a duration (e.g. 30s, 15m, 2h) or an RFC3339 timestamp.",
    }),
    source: Flags.string({
      description: "Restrict logs to a single declared source id (or `console` for the engine stream).",
    }),
  };
  static override landoSpec: LandoCommandSpec = logsSpec;
  static override bootstrap = logsSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = (await this.parse(LogsCommand)) as { readonly flags: LogsFlags };
    await this.runEffect(parsed.flags.follow === true ? followLogsSpec : logsSpec);
  }
}
