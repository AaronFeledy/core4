import type { ExecChunk } from "@lando/sdk/services";
import { Effect, Option, type Stream } from "effect";

import { type ExecStreamCompletion, drainExecStream } from "./exec-stream-drain.ts";
import { type StreamFrameSinkShape, createCollectingStreamFrameSink } from "./stream-frame-sink.ts";

/**
 * Drains an exec stream. With a live sink, frames are emitted and stdout/stderr are omitted
 * so memory stays constant. Without a sink, channels are collected for the result.
 */
export const collectExecStream = Effect.fnUntraced(function* <E, R, E2>(
  stream: Stream.Stream<ExecChunk, E, R>,
  sink: Option.Option<StreamFrameSinkShape>,
  completion: ExecStreamCompletion<E2>,
): Effect.fn.Return<
  { readonly exitCode: number; readonly stdout?: string; readonly stderr?: string },
  E | E2,
  R
> {
  const output = Option.match(sink, {
    onNone: createCollectingStreamFrameSink,
    onSome: (provided) => ({
      sink: provided,
      finish: () => Effect.void,
      result: () => ({}),
    }),
  });
  const exitCode = yield* drainExecStream(
    stream,
    (chunk) =>
      // Live frames keep the provider bytes so a redirected archive stays intact.
      chunk.chunk.length === 0
        ? Effect.void
        : output.sink.emit({ _tag: chunk.kind, chunk: chunk.chunk, kind: "bytes" }),
    completion,
  ).pipe(Effect.scoped, Effect.ensuring(output.finish()));
  return {
    exitCode,
    ...output.result(),
  };
}, Effect.scoped);
