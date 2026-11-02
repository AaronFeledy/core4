import {
  CONTROL_STDOUT_LIMIT,
  type CommandOutputFailure,
  captureCommandOutput,
} from "@lando/container-runtime/command-output";
import { SqlCommandFailedError } from "@lando/sdk/errors";
import type { Environment } from "@lando/sdk/schema";
import type { ExecChunk } from "@lando/sdk/services";
import { Effect, type Stream } from "effect";
import { resolveSqlEnvironment } from "./environment.ts";

export const sqlCommandFailure = (
  service: string,
  command: ReadonlyArray<string>,
  evidence: CommandOutputFailure,
) =>
  new SqlCommandFailedError({
    message: `Database command failed in ${service}.`,
    service,
    command,
    exitCode: evidence.exitCode,
    reason: evidence.reason,
    stderrTail: evidence.stderrTail,
    remediation:
      evidence.role === "cleanup"
        ? "Inspect the service logs and resolve cleanup before retrying; the command may already have completed."
        : "Inspect the service logs, then retry the import, export, or reset.",
  });

export const checkedSqlExecution = Effect.fnUntraced(function* <E, R>(
  execution: Stream.Stream<ExecChunk, E, R>,
  context: {
    readonly service: string;
    readonly command: ReadonlyArray<string>;
    readonly env?: Environment;
    readonly stdout?: "discard";
  },
) {
  const env = context.env === undefined ? undefined : yield* resolveSqlEnvironment(context.env);
  return yield* captureCommandOutput(execution, {
    stdoutLimit: CONTROL_STDOUT_LIMIT,
    stdout: context.stdout === "discard" ? "discard" : "forward",
    authoritativeTokens: env === undefined ? [] : Object.values(env),
    failure: (evidence) => sqlCommandFailure(context.service, context.command, evidence),
  });
});
