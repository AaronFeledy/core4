import { Context, Effect, Option, Stream } from "effect";

import type { ExecChunk } from "./provider.ts";

// ==== Live command output: the sink a streaming command emits child output to ====

interface StreamFrameProvenance {
  readonly _tag: "stdout" | "stderr";
  readonly service?: string;
  readonly source?: string;
}

/**
 * One piece of live command output. `bytes` chunks are raw child output and may
 * split a line or a UTF-8 sequence; a `record` chunk is one complete line.
 */
export type StreamFrameSinkFrame = StreamFrameProvenance &
  (
    | { readonly kind: "bytes"; readonly chunk: string | Uint8Array }
    | { readonly kind: "record"; readonly chunk: string }
  );

export interface StreamFrameSinkShape {
  readonly emit: (frame: StreamFrameSinkFrame) => Effect.Effect<void>;
}

/**
 * The invocation's live output sink. Present only while a caller streams the
 * command's output: the CLI for a command that declares `streamingMode: "live"`,
 * MCP as progress notifications. Read it with `Effect.serviceOption`; without it,
 * collect the output into the command result instead. The sink owns redaction
 * and encoding, so emit raw child output.
 */
export class StreamFrameSink extends Context.Service<StreamFrameSink, StreamFrameSinkShape>()(
  "@lando/core/StreamFrameSink",
) {}

/** A sink that collects stdout and stderr text for a command result. */
export const createCollectingStreamFrameSink = () => {
  const decoders = {
    stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
    stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
  };
  const channels = { stdout: "", stderr: "" };
  let finished = false;
  const sink: StreamFrameSinkShape = {
    emit: (frame) =>
      Effect.sync(() => {
        if (finished) throw new Error("Command output is already finished.");
        channels[frame._tag] +=
          typeof frame.chunk === "string"
            ? decoders[frame._tag].decode() + frame.chunk
            : decoders[frame._tag].decode(frame.chunk, { stream: true });
        if (frame.kind === "record") channels[frame._tag] += "\n";
      }),
  };
  const finish = () =>
    Effect.sync(() => {
      if (finished) return;
      finished = true;
      channels.stdout += decoders.stdout.decode();
      channels.stderr += decoders.stderr.decode();
    });
  return { sink, finish, result: () => ({ ...channels }) };
};

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
