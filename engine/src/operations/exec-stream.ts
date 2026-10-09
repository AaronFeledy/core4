import { Effect, Option, Stream } from "effect";

import type { ExecChunk } from "@lando/sdk/services";

import type { StreamFrameSinkShape } from "./stream-frame-sink.ts";

export const emitRaw = (
  sink: Option.Option<StreamFrameSinkShape>,
  kind: "stdout" | "stderr",
  text: string,
): Effect.Effect<void> => {
  if (text.length === 0 || Option.isNone(sink)) return Effect.void;
  return sink.value.emit({ _tag: kind, chunk: text, raw: true });
};

export const collectExecStream = Effect.fnUntraced(function* <E, R>(
  stream: Stream.Stream<ExecChunk, E, R>,
  sink: Option.Option<StreamFrameSinkShape>,
): Effect.fn.Return<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }, E, R> {
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  yield* stream.pipe(
    Stream.runForEach((chunk) => {
      if ("exitCode" in chunk) {
        exitCode = chunk.exitCode;
        return Effect.void;
      }
      const decoder = chunk.kind === "stdout" ? stdoutDecoder : stderrDecoder;
      const text = decoder.decode(chunk.chunk, { stream: true });
      if (chunk.kind === "stdout") stdout += text;
      else stderr += text;
      return emitRaw(sink, chunk.kind, text);
    }),
  );
  const stdoutTail = stdoutDecoder.decode();
  const stderrTail = stderrDecoder.decode();
  stdout += stdoutTail;
  stderr += stderrTail;
  yield* emitRaw(sink, "stdout", stdoutTail);
  yield* emitRaw(sink, "stderr", stderrTail);
  return { exitCode, stdout, stderr };
}, Effect.scoped);
