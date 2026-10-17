import { Effect, Option } from "effect";
import { StreamFrameSink, createCollectingStreamFrameSink } from "./stream-frame-sink.ts";

export const withToolingOutput = Effect.fnUntraced(function* <
  A extends { readonly stdout: string; readonly stderr: string },
  E,
  R,
>(effect: Effect.Effect<A, E, R>): Effect.fn.Return<A, E, Exclude<R, StreamFrameSink>> {
  const provided = yield* Effect.serviceOption(StreamFrameSink);
  const output = Option.match(provided, {
    onNone: createCollectingStreamFrameSink,
    onSome: (sink) => ({ sink, result: () => ({ stdout: "", stderr: "" }) }),
  });
  const sink = output.sink;
  // Children share one logical stream: only the task boundary may flush a secret prefix.
  const result = yield* effect.pipe(
    Effect.provideService(StreamFrameSink, { emit: sink.emit }),
    Effect.ensuring(sink.flush === undefined ? Effect.void : sink.flush()),
  );
  return { ...result, ...output.result() };
});
