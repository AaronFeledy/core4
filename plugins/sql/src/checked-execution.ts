import {
  CONTROL_STDOUT_LIMIT,
  type CommandOutputFailure,
  captureCommandOutput,
} from "@lando/container-runtime/command-output";
import { RedactionService } from "@lando/redaction/service";
import { SqlCommandFailedError } from "@lando/sdk/errors";
import type { Environment } from "@lando/sdk/schema";
import { type ExecChunk, StreamFrameSink } from "@lando/sdk/services";
import { Effect, Option, type Stream } from "effect";
import { type SqlCredentialSecrets, resolveSqlEnvironment } from "./environment.ts";

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
    ...(evidence.cause === undefined ? {} : { cause: evidence.cause }),
    remediation:
      (evidence.cause?.remediation ?? "Inspect the service logs, then retry the import, export, or reset.") +
      (evidence.role === "cleanup"
        ? " Resolve cleanup before retrying; the command may already have completed."
        : ""),
  });

// Explicit tiers keep public env values out of failure-tail redaction.
export const checkedSqlExecution = Effect.fnUntraced(function* <E, R>(
  execution: Stream.Stream<ExecChunk, E, R>,
  context: {
    readonly service: string;
    readonly command: ReadonlyArray<string>;
    readonly env?: Environment;
    readonly secrets?: SqlCredentialSecrets | (() => SqlCredentialSecrets);
    readonly stdout?: "discard";
    /** The database client's work is the user's to watch: stream its stderr to a live sink. */
    readonly live?: true;
  },
) {
  // Resolution triggers credential registration before reading the secret tiers.
  if (context.env !== undefined) yield* resolveSqlEnvironment(context.env);
  const secrets =
    typeof context.secrets === "function"
      ? context.secrets()
      : (context.secrets ?? { substring: [], wholeToken: [] });
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "Some" && secrets.wholeToken.length > 0) {
    yield* redaction.value.registerValues(secrets.wholeToken, { match: "whole-token" });
  }
  const sink = context.live === true ? yield* Effect.serviceOption(StreamFrameSink) : Option.none();
  return yield* captureCommandOutput(execution, {
    stdoutLimit: CONTROL_STDOUT_LIMIT,
    stdout: context.stdout === "discard" ? "discard" : "forward",
    ...(Option.isSome(sink) ? { live: { sink: sink.value, service: context.service } } : {}),
    // Failure-tail tokens are substring-only.
    authoritativeTokens: secrets.substring,
    failure: (evidence) => sqlCommandFailure(context.service, context.command, evidence),
  });
});
