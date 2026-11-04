import { Effect, Option, Stream } from "effect";

import type { ExecChunk } from "@lando/sdk/services";

import { type StreamFrameSinkShape, createCollectingStreamFrameSink } from "./stream-frame-sink.ts";

/**
 * Drains an exec stream. With a live sink, frames are emitted and stdout/stderr are omitted
 * so memory stays constant. Without a sink, channels are collected for the result.
 */
export const collectExecStream = Effect.fnUntraced(function* <E, R>(
  stream: Stream.Stream<ExecChunk, E, R>,
  sink: Option.Option<StreamFrameSinkShape>,
): Effect.fn.Return<{ readonly exitCode: number; readonly stdout?: string; readonly stderr?: string }, E, R> {
  const output = Option.match(sink, {
    onNone: createCollectingStreamFrameSink,
    onSome: (provided) => ({
      sink: provided,
      finish: () => Effect.void,
      result: () => ({}),
    }),
  });
  let exitCode = 0;
  yield* stream.pipe(
    Stream.runForEach((chunk) => {
      if ("exitCode" in chunk) {
        exitCode = chunk.exitCode;
        return Effect.void;
      }
      // Live frames keep the provider bytes so a redirected archive stays intact.
      return chunk.chunk.length === 0
        ? Effect.void
        : output.sink.emit({ _tag: chunk.kind, chunk: chunk.chunk, kind: "bytes" });
    }),
    Effect.scoped,
    Effect.ensuring(output.finish()),
  );
  return {
    exitCode,
    ...output.result(),
  };
}, Effect.scoped);
