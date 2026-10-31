import type { ToolingResult } from "@lando/sdk/schema";
import { Effect, Option } from "effect";
import { StreamFrameSink, createCollectingStreamFrameSink } from "./stream-frame-sink.ts";

export const withToolingOutput = Effect.fnUntraced(function* <
  A extends Pick<ToolingResult, "stdout" | "stderr">,
  E,
  R,
>(
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<
  Omit<A, "stdout" | "stderr"> & Pick<ToolingResult, "stdout" | "stderr">,
  E,
  Exclude<R, StreamFrameSink>
> {
  const provided = yield* Effect.serviceOption(StreamFrameSink);
  const output = Option.match(provided, {
    onNone: createCollectingStreamFrameSink,
    onSome: (sink) => ({ sink, finish: () => Effect.void, result: () => ({}) }),
  });
  const sink = output.sink;
  const emitted = { stdout: false, stderr: false };
  // Children share one logical stream: only the task boundary may flush a secret prefix.
  const result = yield* effect.pipe(
    Effect.provideService(StreamFrameSink, {
      emit: (frame) =>
        Effect.suspend(() => {
          if (frame.chunk.length > 0) emitted[frame._tag] = true;
          return sink.emit(frame);
        }),
    }),
    Effect.tap((returned) =>
      Effect.forEach(["stdout", "stderr"] as const, (channel) =>
        !emitted[channel] && returned[channel]
          ? sink.emit({ _tag: channel, chunk: returned[channel], kind: "bytes" })
          : Effect.void,
      ),
    ),
    Effect.scoped,
    Effect.ensuring(output.finish()),
  );
  const { stdout: _stdout, stderr: _stderr, ...metadata } = result;
  return { ...metadata, ...output.result() };
});
