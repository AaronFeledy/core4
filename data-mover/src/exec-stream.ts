import { Effect, Option, Stream } from "effect";

import type { DataTransferError } from "@lando/sdk/errors";
import type { ExecChunk } from "@lando/sdk/services";

export const execStdoutStream = <E, R>(
  source: Stream.Stream<ExecChunk, E, R>,
  failedExit: (exitCode: number) => DataTransferError,
): Stream.Stream<Uint8Array, E | DataTransferError, R> =>
  source.pipe(
    Stream.mapEffect((chunk) => {
      if ("exitCode" in chunk) {
        return chunk.exitCode === 0 ? Effect.succeed(Option.none()) : Effect.fail(failedExit(chunk.exitCode));
      }
      return Effect.succeed(chunk.kind === "stdout" ? Option.some(chunk.chunk) : Option.none());
    }),
    Stream.filterMap((chunk) => chunk),
  );
