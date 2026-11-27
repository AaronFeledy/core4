import {
  type CommandOutputFailure,
  type CommandOutputLive,
  commandOutputStream,
} from "@lando/container-runtime/command-output";
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
  live?: CommandOutputLive,
) =>
  commandOutputStream(source, {
    authoritativeTokens,
    ...(live === undefined ? {} : { live }),
    failure: (evidence) => failedExit(evidence.exitCode, evidence.stderrTail, evidence),
  });
