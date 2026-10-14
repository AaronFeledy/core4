import { Effect, Option, Stream } from "effect";

import type { ExecChunk } from "@lando/sdk/services";

import type { StreamFrameSinkShape } from "./stream-frame-sink.ts";

export const emitRaw = (
  sink: Option.Option<StreamFrameSinkShape>,
  kind: "stdout" | "stderr",
  chunk: string | Uint8Array,
): Effect.Effect<void> => {
  const empty = typeof chunk === "string" ? chunk.length === 0 : chunk.byteLength === 0;
  if (empty || Option.isNone(sink)) return Effect.void;
  return sink.value.emit({ _tag: kind, chunk, raw: true });
};

/** Collects the exec stream and emits live frames. stdout/stderr stay in memory for the result. */
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
      // Live frames keep the provider bytes so a redirected archive stays intact.
      return emitRaw(sink, chunk.kind, chunk.chunk);
    }),
    Effect.ensuring(
      Effect.gen(function* () {
        stdout += stdoutDecoder.decode();
        stderr += stderrDecoder.decode();
        if (Option.isSome(sink) && sink.value.flush !== undefined) {
          yield* sink.value.flush();
        }
      }),
    ),
  );
  return { exitCode, stdout, stderr };
}, Effect.scoped);
