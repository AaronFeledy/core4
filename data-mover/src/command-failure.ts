import { type CommandOutputFailure, captureCommandOutput } from "@lando/container-runtime/command-output";
import { DataTransferError } from "@lando/sdk/errors";
import type { ExecChunk } from "@lando/sdk/services";
import { Effect, type Stream } from "effect";

export const serviceCommandFailure = (
  operation: string,
  exitCode?: number,
  stderrTail?: string,
  evidence?: CommandOutputFailure,
): DataTransferError =>
  new DataTransferError({
    message: `Service command ${operation} failed during data transfer.`,
    operation,
    exitCode,
    stderrTail,
    reason: evidence?.reason,
    remediation:
      evidence?.role === "cleanup"
        ? "Inspect and resolve the reported failure, including cleanup, before deciding whether to repeat the transfer; it may already have completed."
        : "Inspect the service command and retry after the service is healthy.",
  });

export const checkedTransferCommand = Effect.fnUntraced(function* <E, R>(
  command: Stream.Stream<ExecChunk, E, R>,
  operation: string,
  authoritativeTokens?: Iterable<string>,
) {
  return yield* captureCommandOutput(command, {
    stdout: "discard",
    authoritativeTokens,
    failure: (evidence) => serviceCommandFailure(operation, evidence.exitCode, evidence.stderrTail, evidence),
  });
});
