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

interface ExecStreamCompletion<E> {
  readonly signal?: AbortSignal | undefined;
  readonly failure: () => E;
}

/** Resolve an observed status after a clean command stream drain. */
export const requireObservedExit = <E>(
  exitCode: number | undefined,
  completion: ExecStreamCompletion<E>,
): Effect.Effect<number, E> => {
  if (exitCode !== undefined) return Effect.succeed(exitCode);
  return completion.signal?.aborted === true ? Effect.interrupt : Effect.fail(completion.failure());
};

/** Drain output without taking ownership of the caller's scope or byte sink. */
export const drainExecStream = Effect.fnUntraced(function* <E, R, E2>(
  stream: Stream.Stream<ExecChunk, E, R>,
  write: (chunk: Exclude<ExecChunk, { readonly exitCode: number }>) => Effect.Effect<void>,
  completion: ExecStreamCompletion<E2>,
): Effect.fn.Return<number, E | E2, R> {
  let exitCode: number | undefined;
  yield* Stream.runForEach(stream, (chunk) => {
    if ("exitCode" in chunk) {
      exitCode = chunk.exitCode;
      return Effect.void;
    }
    return write(chunk);
  });
  return yield* requireObservedExit(exitCode, completion);
});

/**
 * Drains an exec stream. With a live sink, frames are emitted and stdout/stderr are omitted
 * so memory stays constant. Without a sink, channels are collected for the result. A clean
 * drain without a status fails using the caller's completion policy.
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
