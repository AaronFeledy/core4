import {
  CONTROL_STDOUT_LIMIT,
  type CommandOutputFailure,
  captureCommandOutput,
} from "@lando/container-runtime/command-output";
import { RedactionService } from "@lando/redaction/service";
import { SqlCommandFailedError } from "@lando/sdk/errors";
import type { Environment } from "@lando/sdk/schema";
import type { ExecChunk } from "@lando/sdk/services";
import { Effect, type Stream } from "effect";
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
    remediation:
      evidence.role === "cleanup"
        ? "Inspect the service logs and resolve cleanup before retrying; the command may already have completed."
        : "Inspect the service logs, then retry the import, export, or reset.",
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
  return yield* captureCommandOutput(execution, {
    stdoutLimit: CONTROL_STDOUT_LIMIT,
    stdout: context.stdout === "discard" ? "discard" : "forward",
    // Failure-tail tokens are substring-only.
    authoritativeTokens: secrets.substring,
    failure: (evidence) => sqlCommandFailure(context.service, context.command, evidence),
  });
});
