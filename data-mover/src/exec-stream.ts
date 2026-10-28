import { type CommandOutputFailure, commandOutputStream } from "@lando/container-runtime/command-output";
import type { DataTransferError } from "@lando/sdk/errors";
import type { ExecChunk } from "@lando/sdk/services";
import type { Stream } from "effect";

export const execStdoutStream = <E, R>(
  source: Stream.Stream<ExecChunk, E, R>,
  failedExit: (
    exitCode: number | undefined,
    stderrTail?: string,
    evidence?: CommandOutputFailure,
  ) => DataTransferError,
  authoritativeTokens?: Iterable<string>,
) =>
  commandOutputStream(source, {
    authoritativeTokens,
    failure: (evidence) => failedExit(evidence.exitCode, evidence.stderrTail, evidence),
  });
