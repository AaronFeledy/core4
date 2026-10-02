import { Effect, Result, Stream } from "effect";

import type { DataTransferError } from "@lando/sdk/errors";
import type { ExecChunk } from "@lando/sdk/services";

export const execStdoutStream = <E, R>(
  source: Stream.Stream<ExecChunk, E, R>,
  failedExit: (exitCode: number) => DataTransferError,
): Stream.Stream<Uint8Array, E | DataTransferError, R> =>
  source.pipe(
    Stream.mapEffect((chunk) => {
      if ("exitCode" in chunk) {
        return chunk.exitCode === 0
          ? Effect.succeed(Result.fail(undefined))
          : Effect.fail(failedExit(chunk.exitCode));
      }
      return Effect.succeed(chunk.kind === "stdout" ? Result.succeed(chunk.chunk) : Result.fail(undefined));
    }),
    Stream.filterMap((chunk) => chunk),
  );
