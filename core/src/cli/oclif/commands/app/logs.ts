import { Flags } from "@oclif/core";
import { Effect } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";

import { type LogsAppResult, logsApp, renderLogsAppResult } from "../../../commands/logs.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

interface LogsFlags {
  readonly service?: string;
  readonly follow?: boolean;
  readonly tail?: number;
  readonly since?: string;
}

const LOGS_FOLLOW_DEFERRED = new NotImplementedError({
  message:
    "`lando logs --follow` streaming output is deferred to Beta. Alpha returns a finite snapshot via `--tail`.",
  commandId: "app:logs",
  specSection: "spec/08-cli-and-tooling.md",
  remediation: "Drop --follow and rely on --tail <N> for a finite log snapshot.",
});

const LOGS_SINCE_DEFERRED = new NotImplementedError({
  message:
    "`lando logs --since` is deferred to Beta (provider LogOptions does not yet expose a since cursor).",
  commandId: "app:logs",
  specSection: "spec/08-cli-and-tooling.md",
  remediation: "Drop --since and use --tail <N> for a finite recent snapshot.",
});

export const logsSpec: LandoCommandSpec<LogsAppResult> = {
  id: "app:logs",
  summary: "Stream logs from the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => logsApp(),
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
    if (parsed.flags.follow === true) {
      await this.runEffect({ ...logsSpec, run: () => Effect.fail(LOGS_FOLLOW_DEFERRED) });
      return;
    }
    if (parsed.flags.since !== undefined) {
      await this.runEffect({ ...logsSpec, run: () => Effect.fail(LOGS_SINCE_DEFERRED) });
      return;
    }
    await this.runEffect({
      ...logsSpec,
      run: () =>
        logsApp({
          ...(parsed.flags.service === undefined ? {} : { service: parsed.flags.service }),
          ...(parsed.flags.tail === undefined ? {} : { tail: parsed.flags.tail }),
        }),
    });
  }
}
