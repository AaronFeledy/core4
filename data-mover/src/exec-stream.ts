import { Effect, Result, Stream } from "effect";

import { makeDiagnosticTail } from "@lando/redaction";
import type { DataTransferError } from "@lando/sdk/errors";
import type { ExecChunk } from "@lando/sdk/services";

export const execStdoutStream = <E, R>(
  source: Stream.Stream<ExecChunk, E, R>,
  failedExit: (exitCode: number | undefined, stderrTail?: string) => DataTransferError,
  env?: Readonly<Record<string, string>>,
): Stream.Stream<Uint8Array, DataTransferError, R> =>
  Stream.unwrap(
    Effect.map(makeDiagnosticTail(env), (tail) =>
      source.pipe(
        Stream.mapError(() => failedExit(undefined, tail.finish())),
        Stream.mapEffect((chunk) => {
          if ("exitCode" in chunk) {
            return chunk.exitCode === 0
              ? Effect.succeed(Result.fail(undefined))
              : Effect.fail(failedExit(chunk.exitCode, tail.finish()));
          }
          if (chunk.kind === "stderr") tail.write(chunk.chunk);
          return Effect.succeed(
            chunk.kind === "stdout" ? Result.succeed(chunk.chunk) : Result.fail(undefined),
          );
        }),
        Stream.filterMap((chunk) => chunk),
      ),
    ),
  );
