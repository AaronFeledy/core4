/**
 * Renderer layer construction and output-line primitives.
 *
 * Maps a resolved {@link RendererMode} to the concrete `Renderer` service layer,
 * event-consumer layer, and notification-consumer layer, and exposes the small
 * write helpers (`writeStdout`/`writeResultLine`/`writeDiagnosticLine`/optional
 * emitters) plus the streaming `StreamFrameSink` layer used by the command
 * boundary. The JSON branch of the stream sink is byte-stable machine output.
 */
import { Effect, Layer, Option } from "effect";

import { encodeStreamStderrFrame, encodeStreamStdoutFrame } from "@lando/sdk/command-result";
import { type RendererContribution, narrationIO } from "@lando/sdk/renderer";
import type { CommandResultFormat } from "@lando/sdk/schema";
import { createPayloadRedactor } from "@lando/sdk/secrets";
import { type EventService, Renderer } from "@lando/sdk/services";

import { StreamFrameSink, type StreamFrameSinkFrame } from "@lando/engine/operations/stream-frame-sink";
import { RedactionService } from "@lando/redaction/service";
import { type RendererIO, createStdioRendererIO } from "./io.ts";
import * as RendererRuntime from "./runtime.ts";

type RendererMode = "lando" | "json" | "plain" | "verbose";

export const layerServiceForMode = (
  mode: RendererMode,
  landoRenderer: RendererContribution,
  io: RendererIO = createStdioRendererIO(),
): Layer.Layer<Renderer> => {
  switch (mode) {
    case "json":
      return RendererRuntime.layerJsonService(io);
    case "plain":
      return RendererRuntime.layerPlainService(io);
    case "verbose":
      return RendererRuntime.layerVerboseService(io);
    case "lando":
      return landoRenderer.makeService(io);
  }
};

export interface RendererEventConsumerOptions {
  readonly landoRenderer: RendererContribution;
}

export const layerEventConsumerForMode = (
  mode: RendererMode,
  io: RendererIO,
  options: RendererEventConsumerOptions,
): Layer.Layer<never, never, EventService> => {
  const narration = narrationIO(io);
  switch (mode) {
    case "json":
      return RendererRuntime.layerJson(narration);
    case "plain":
      return RendererRuntime.layerPlain(narration);
    case "verbose":
      return RendererRuntime.layerVerbose(narration);
    case "lando":
      return options.landoRenderer.makeEventConsumer(narration);
  }
};

export const layerNotificationConsumerForMode = (
  mode: RendererMode,
  landoRenderer: RendererContribution,
  io: RendererIO,
): Layer.Layer<never, never, EventService> | undefined => {
  switch (mode) {
    case "json":
      return RendererRuntime.layerJsonNotification(io);
    case "lando":
      // Machine result formats keep human narration off both streams.
      return landoRenderer.makeEventConsumer({
        writeStderr: () => {},
        ...(io.isTTY === undefined ? {} : { isTTY: io.isTTY }),
      });
    case "plain":
      return undefined;
    case "verbose":
      return RendererRuntime.layerVerbose(io);
  }
};

const optionalRenderer = Effect.serviceOption(Renderer);

export const emitOptionalStdout = (chunk: string | Uint8Array): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stdout(chunk) : Effect.void)),
  );

export const emitOptionalStderr = (chunk: string | Uint8Array): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stderr(chunk) : Effect.void)),
  );

export const withOptionalStderrOutput = <A extends { readonly stderr: string }, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.tap((result) => (result.stderr.length === 0 ? Effect.void : emitOptionalStderr(result.stderr))),
  );

const requireRenderer = Effect.serviceOption(Renderer).pipe(
  Effect.flatMap((option) =>
    Option.isNone(option)
      ? Effect.die(new Error("Renderer not provided at the CLI command boundary"))
      : Effect.succeed(option.value),
  ),
);

export const writeStdout = (chunk: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(chunk)));

export const writeResultLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(`${text}\n`)));

export const writeDiagnosticLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stderr(`${text}\n`)));

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left);
  out.set(right, left.byteLength);
  return out;
};

export const makeStreamFrameSink = Effect.fnUntraced(function* (format: CommandResultFormat) {
  const renderer = yield* Renderer;
  const redaction = yield* RedactionService;
  const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
  const values = yield* redaction.payloadValues({ sourceEnv: process.env });
  const encoder = new TextEncoder();
  const states = new Map<
    string,
    {
      readonly frame: StreamFrameSinkFrame;
      readonly payload: ReturnType<typeof createPayloadRedactor>;
      readonly decoder: TextDecoder;
      pending: Uint8Array;
    }
  >();
  const write = Effect.fnUntraced(function* (
    state: NonNullable<ReturnType<typeof states.get>>,
    bytes: Uint8Array,
    final = false,
  ): Effect.fn.Return<void> {
    if (bytes.length === 0 && !final) return;
    const frame = state.frame;
    if (format === "json") {
      const textChunk = state.decoder.decode(bytes, { stream: !final });
      if (textChunk.length === 0) return;
      const streamFrameOptions = {
        chunk: textChunk,
        ...(frame.service === undefined ? {} : { service: frame.service }),
        ...(frame.source === undefined ? {} : { source: frame.source }),
        redactor,
      };
      const line =
        frame._tag === "stdout"
          ? yield* encodeStreamStdoutFrame(streamFrameOptions)
          : yield* encodeStreamStderrFrame(streamFrameOptions);
      yield* renderer.output.stdout(`${line}\n`);
      return;
    }
    if (format === "yaml") return;
    if (frame.kind === "bytes") {
      yield* frame._tag === "stderr" ? renderer.output.stderr(bytes) : renderer.output.stdout(bytes);
      return;
    }
    const chunk = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    const text =
      frame.service === undefined
        ? chunk
        : frame.source === undefined
          ? `${frame.service} ${frame._tag}: ${chunk}`
          : `${frame.service} ${frame._tag} [${frame.source}]: ${chunk}`;
    yield* frame._tag === "stderr"
      ? renderer.output.stderr(`${text}\n`)
      : renderer.output.stdout(`${text}\n`);
  });
  const deliver = Effect.fnUntraced(function* (
    state: NonNullable<ReturnType<typeof states.get>>,
    bytes: Uint8Array,
    final = false,
  ): Effect.fn.Return<void> {
    if (format !== "json") {
      yield* write(state, bytes);
      return;
    }
    let offset = 0;
    while (offset < bytes.length) {
      const remaining = 65536 - state.pending.length;
      const newline = bytes.indexOf(10, offset);
      const end = Math.min(bytes.length, offset + remaining, newline < 0 ? bytes.length : newline + 1);
      state.pending = concatBytes(state.pending, bytes.subarray(offset, end));
      offset = end;
      if (state.pending.length === 65536 || state.pending.at(-1) === 10) {
        yield* write(state, state.pending);
        state.pending = new Uint8Array(0);
      }
    }
    if (final) {
      yield* write(state, state.pending, true);
      state.pending = new Uint8Array(0);
    }
  });
  let finished = false;
  const emit = Effect.fnUntraced(function* (frame: StreamFrameSinkFrame): Effect.fn.Return<void> {
    if (finished) return yield* Effect.die(new Error("Command output is already finished."));
    const key = JSON.stringify([frame._tag, frame.service, frame.source]);
    let state = states.get(key);
    if (state === undefined) {
      state = {
        frame: { ...frame, chunk: "" },
        payload: createPayloadRedactor(values),
        decoder: new TextDecoder("utf-8", { ignoreBOM: true }),
        pending: new Uint8Array(0),
      };
      states.set(key, state);
    }
    const bytes = typeof frame.chunk === "string" ? encoder.encode(frame.chunk) : frame.chunk;
    if (frame.kind === "record") {
      yield* deliver(state, state.payload.flush(), true);
      states.delete(key);
      const record = {
        ...state,
        frame,
        decoder: new TextDecoder("utf-8", { ignoreBOM: true }),
        pending: new Uint8Array(0),
      };
      const bytes = encoder.encode(redactor.redactString(`${frame.chunk}${format === "json" ? "\n" : ""}`));
      if (format === "json") yield* deliver(record, bytes, true);
      else yield* write(record, bytes);
      return;
    }
    yield* deliver(state, state.payload.write(bytes));
  });
  const finish = Effect.fnUntraced(function* (): Effect.fn.Return<void> {
    if (finished) return;
    finished = true;
    for (const state of states.values()) {
      yield* deliver(state, state.payload.flush(), true);
    }
    states.clear();
  });
  return { sink: StreamFrameSink.of({ emit }), finish };
});

export const layerStreamFrameSink = (format: CommandResultFormat) =>
  Layer.effect(
    StreamFrameSink,
    Effect.gen(function* () {
      const owner = yield* makeStreamFrameSink(format);
      yield* Effect.addFinalizer(owner.finish);
      return owner.sink;
    }),
  );
