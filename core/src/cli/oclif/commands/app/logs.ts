import { Flags } from "@oclif/core";
import { Effect } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";
import { StreamFrame } from "@lando/sdk/schema";

import { type LogsAppResult, logsApp, renderLogsAppResult } from "../../../commands/logs.ts";
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
}

const deferredLogsError = (message: string, remediation: string): NotImplementedError =>
  new NotImplementedError({
    message,
    commandId: "app:logs",
    remediation,
  });

export const LOGS_FOLLOW_DEFERRED = deferredLogsError(
  "`lando logs --follow` streaming output is deferred to Beta. Alpha returns a finite snapshot via `--tail`.",
  "Drop --follow and rely on --tail <N> for a finite log snapshot.",
);

export const LOGS_SINCE_DEFERRED = deferredLogsError(
  "`lando logs --since` is not available yet (provider LogOptions does not yet expose a since cursor).",
  "Drop --since and use --tail <N> for a finite recent snapshot.",
);

export const logsDeferredErrorFromInput = (input: unknown): NotImplementedError | undefined => {
  const flags =
    typeof input === "object" && input !== null
      ? ((input as { readonly flags?: LogsFlags }).flags ?? {})
      : {};
  return flags.follow === true
    ? LOGS_FOLLOW_DEFERRED
    : flags.since !== undefined
      ? LOGS_SINCE_DEFERRED
      : undefined;
};

export const logsOptionsFromInput = (input: unknown): Parameters<typeof logsApp>[0] => {
  const flags =
    typeof input === "object" && input !== null
      ? ((input as { readonly flags?: LogsFlags }).flags ?? {})
      : {};
  return {
    ...(flags.service === undefined ? {} : { service: flags.service }),
    ...(flags.tail === undefined ? {} : { tail: flags.tail }),
  };
};

export const logsSpec: LandoCommandSpec<LogsAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:logs",
  summary: "Stream logs from the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  streaming: StreamFrame,
  run: () => logsApp(),
  streamFrames: (value) => {
    const result = value as LogsAppResult;
    return result.lines.map((line) => ({
      _tag: line.stream,
      service: line.service,
      chunk: `${line.line}\n`,
    }));
  },
  render: (result) => renderLogsAppResult(result as LogsAppResult),
};

export default class LogsCommand extends LandoCommandBase {
  static override description = logsSpec.summary;
  static override aliases = [...resolveTopLevelAliases(logsSpec)];
  static override flags = {
    service: Flags.string({ char: "s", description: "Filter logs to a single planned service." }),
    follow: Flags.boolean({ char: "f", description: "Stream new log lines (deferred to Beta)." }),
    tail: Flags.integer({ description: "Show last N lines per service." }),
    since: Flags.string({ description: "Filter to lines since the given time (deferred to Beta)." }),
  };
  static override landoSpec: LandoCommandSpec = logsSpec;
  static override bootstrap = logsSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = (await this.parse(LogsCommand)) as { readonly flags: LogsFlags };
    const deferredError = logsDeferredErrorFromInput(parsed);
    if (deferredError !== undefined) {
      await this.runEffect({ ...logsSpec, run: () => Effect.fail(deferredError) });
      return;
    }
    await this.runEffect({
      ...logsSpec,
      run: () => logsApp(logsOptionsFromInput(parsed)),
    });
  }
}
