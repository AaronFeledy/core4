import { Flags } from "@oclif/core";

import { StreamFrame } from "@lando/sdk/schema";

import {
  type GlobalLogsResult,
  followGlobalLogs,
  globalLogs,
  renderGlobalLogsResult,
} from "../../../../commands/meta/global-logs.ts";
import { normalizeCliFlagTokens } from "../../../../flag-value-validation.ts";
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../../command-base.ts";

export interface GlobalLogsFlags {
  readonly service?: string;
  readonly follow?: boolean;
  readonly tail?: number;
  readonly since?: string;
}

const flagsFromInput = (input: unknown): GlobalLogsFlags =>
  typeof input === "object" && input !== null
    ? ((input as { readonly flags?: GlobalLogsFlags }).flags ?? {})
    : {};

export const globalLogsOptionsFromInput = (input: unknown): Parameters<typeof globalLogs>[0] => {
  const flags = flagsFromInput(input);
  return {
    ...(flags.service === undefined ? {} : { service: flags.service }),
    ...(flags.tail === undefined ? {} : { tail: flags.tail }),
    ...(flags.since === undefined ? {} : { since: flags.since }),
  };
};

export const globalLogsFollowFromInput = (input: unknown): boolean => flagsFromInput(input).follow === true;

const signalFromInput = (input: unknown): AbortSignal | undefined =>
  typeof input === "object" && input !== null
    ? (input as { readonly signal?: AbortSignal }).signal
    : undefined;

export const globalLogsSpec: LandoCommandSpec<GlobalLogsResult> = {
  resultSchema: EmptyResultSchema,
  id: "meta:global:logs",
  summary: "Stream logs from the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:logs",
  bootstrap: "global",
  streaming: StreamFrame,
  run: (input) => {
    const options = globalLogsOptionsFromInput(input);
    if (!globalLogsFollowFromInput(input)) return globalLogs(options);
    const signal = signalFromInput(input);
    return followGlobalLogs({ ...options, follow: true, ...(signal === undefined ? {} : { signal }) });
  },
  streamFrames: (value) => {
    const result = value as GlobalLogsResult;
    return result.lines.map((line) => ({
      _tag: line.stream,
      service: line.service,
      chunk: `${line.line}\n`,
    }));
  },
  render: (result) => renderGlobalLogsResult(result as GlobalLogsResult),
};

// Type intentionally left inferred: an explicit LandoCommandSpec annotation makes
// the machine-output gate read this spread variant as missing a literal resultSchema.
const followGlobalLogsSpec = { ...globalLogsSpec, streamingMode: "live" as const };

export default class MetaGlobalLogsCommand extends LandoCommandBase {
  static override description = globalLogsSpec.summary;
  static override aliases = [...resolveTopLevelAliases(globalLogsSpec)];
  static override flags = {
    service: Flags.string({ char: "s", description: "Filter logs to a single global service." }),
    follow: Flags.boolean({ char: "f", description: "Stream new log lines until interrupted." }),
    tail: Flags.integer({ description: "Show last N lines per service." }),
    since: Flags.string({
      description: "Only show logs since a duration (e.g. 30s, 15m, 2h) or an RFC3339 timestamp.",
    }),
  };
  static override landoSpec: LandoCommandSpec = globalLogsSpec;
  static override bootstrap = globalLogsSpec.bootstrap;

  override async run(): Promise<void> {
    const normalizedArgv = normalizeCliFlagTokens(this.argv, {
      ...this.ctor.baseFlags,
      ...this.ctor.flags,
    });
    await this.runEffect(
      normalizedArgv.includes("--follow") || normalizedArgv.includes("-f")
        ? followGlobalLogsSpec
        : globalLogsSpec,
    );
  }
}
