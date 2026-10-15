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
import type { RendererContribution } from "@lando/sdk/renderer";
import type { CommandResultFormat } from "@lando/sdk/schema";
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
  readonly plainTaskEvents?: "detail-only";
}

export const layerEventConsumerForMode = (
  mode: RendererMode,
  io: RendererIO,
  options: RendererEventConsumerOptions,
): Layer.Layer<never, never, EventService> => {
  switch (mode) {
    case "json":
      return RendererRuntime.layerJson(io);
    case "plain":
      return options.plainTaskEvents === "detail-only"
        ? RendererRuntime.layerPlainTaskDetail(io)
        : RendererRuntime.layerPlain(io);
    case "verbose":
      return RendererRuntime.layerVerbose(io);
    case "lando":
      return options.landoRenderer.makeEventConsumer(io);
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
      return landoRenderer.makeEventConsumer({
        writeStdout: () => {},
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

export const emitOptionalStdout = (chunk: string): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stdout(chunk) : Effect.void)),
  );

export const emitOptionalStderr = (chunk: string): Effect.Effect<void> =>
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

const byteWriter = (
  io: RendererIO | undefined,
  key: "writeStdoutBytes" | "writeStderrBytes",
): ((chunk: Uint8Array) => void) | undefined => {
  const write = io?.[key];
  return typeof write === "function" ? write : undefined;
};

type Utf8Decode =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary"; readonly bytes: Uint8Array };

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left);
  out.set(right, left.byteLength);
  return out;
};

const utf8SequenceLength = (lead: number): number => {
  if (lead <= 0x7f) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
};

const isUtf8Continuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

const isUtf8SequenceValid = (bytes: Uint8Array, start: number, length: number): boolean => {
  for (let offset = 1; offset < length; offset += 1) {
    if (!isUtf8Continuation(bytes[start + offset] ?? 0)) return false;
  }
  const lead = bytes[start] ?? 0;
  const next = bytes[start + 1] ?? 0;
  if (length === 3 && lead === 0xe0 && next < 0xa0) return false;
  if (length === 3 && lead === 0xed && next >= 0xa0) return false;
  if (length === 4 && lead === 0xf0 && next < 0x90) return false;
  if (length === 4 && lead === 0xf4 && next >= 0x90) return false;
  return true;
};

const scanUtf8 = (bytes: Uint8Array): { readonly completeEnd: number; readonly invalid: boolean } => {
  let index = 0;
  while (index < bytes.byteLength) {
    const length = utf8SequenceLength(bytes[index] ?? 0);
    if (length === 0) return { completeEnd: index, invalid: true };
    if (index + length > bytes.byteLength) {
      for (let offset = 1; offset < bytes.byteLength - index; offset += 1) {
        if (!isUtf8Continuation(bytes[index + offset] ?? 0)) return { completeEnd: index, invalid: true };
      }
      return { completeEnd: index, invalid: false };
    }
    if (!isUtf8SequenceValid(bytes, index, length)) return { completeEnd: index, invalid: true };
    index += length;
  }
  return { completeEnd: index, invalid: false };
};

/**
 * Live-frame UTF-8 policy: redact whenever the destination is a TTY or the
 * stream is valid UTF-8. Pass raw provider bytes only when stdout is
 * redirected and the stream is not valid UTF-8 (gzip/tar archives). Held
 * incomplete bytes are tracked from the input, not by re-encoding decoded
 * text, so a leading BOM cannot shift the leftover count. Those held bytes
 * are written raw when the next chunk is not UTF-8, and again at end of
 * stream on a redirected sink.
 */
const createStreamingUtf8Decoder = (fatal: boolean) => {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let pending: Uint8Array = new Uint8Array(0);
  let binary = false;
  return {
    decode(chunk: Uint8Array): Utf8Decode {
      if (binary) return { kind: "binary", bytes: chunk };
      const buf = concatBytes(pending, chunk);
      const { completeEnd, invalid } = scanUtf8(buf);
      if (invalid) {
        pending = new Uint8Array(0);
        if (!fatal) return { kind: "text", text: decoder.decode(buf) };
        binary = true;
        return { kind: "binary", bytes: buf };
      }
      const complete = buf.subarray(0, completeEnd);
      pending = buf.subarray(completeEnd).slice();
      return { kind: "text", text: complete.byteLength === 0 ? "" : decoder.decode(complete) };
    },
    flush(): Uint8Array | undefined {
      if (pending.byteLength === 0) return undefined;
      const leftover = pending;
      pending = new Uint8Array(0);
      binary = true;
      return leftover;
    },
  };
};

const frameDecode = (
  frame: StreamFrameSinkFrame,
  decoder: { decode: (chunk: Uint8Array) => Utf8Decode },
): Utf8Decode =>
  typeof frame.chunk === "string" ? { kind: "text", text: frame.chunk } : decoder.decode(frame.chunk);

export const layerStreamFrameSink = (
  format: CommandResultFormat,
  io?: RendererIO,
): Layer.Layer<StreamFrameSink, never, Renderer | RedactionService> =>
  Layer.effect(
    StreamFrameSink,
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const redaction = yield* RedactionService;
      const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
      const isTty = io?.isTTY === true;
      const stdoutUtf8 = createStreamingUtf8Decoder(!isTty);
      const stderrUtf8 = createStreamingUtf8Decoder(!isTty);
      const jsonStdout = createStreamingUtf8Decoder(false);
      const jsonStderr = createStreamingUtf8Decoder(false);
      const writeRaw = (tag: "stdout" | "stderr", bytes: Uint8Array): boolean => {
        const writeBytes = byteWriter(io, tag === "stderr" ? "writeStderrBytes" : "writeStdoutBytes");
        if (writeBytes === undefined) return false;
        writeBytes(bytes);
        return true;
      };
      const emit = Effect.fnUntraced(function* (frame: StreamFrameSinkFrame): Effect.fn.Return<void> {
        if (format === "json") {
          const decoded = frameDecode(frame, frame._tag === "stdout" ? jsonStdout : jsonStderr);
          const textChunk = decoded.kind === "text" ? decoded.text : new TextDecoder().decode(decoded.bytes);
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
        // A YAML run emits one envelope document, so a raw chunk would
        // corrupt it. Frame transport belongs to the framed JSON stream.
        if (format === "yaml") return;
        const decoder = frame._tag === "stdout" ? stdoutUtf8 : stderrUtf8;
        const decoded = frameDecode(frame, decoder);
        if (
          frame.raw === true &&
          !isTty &&
          decoded.kind === "binary" &&
          writeRaw(frame._tag, decoded.bytes)
        ) {
          return;
        }
        const fallbackText = decoded.kind === "text" ? decoded.text : new TextDecoder().decode(decoded.bytes);
        const chunk = redactor.redactString(fallbackText);
        if (frame.raw === true) {
          yield* frame._tag === "stderr" ? renderer.output.stderr(chunk) : renderer.output.stdout(chunk);
          return;
        }
        const text =
          frame.service === undefined
            ? chunk
            : frame.source === undefined
              ? `${frame.service} ${frame._tag}: ${chunk}`
              : `${frame.service} ${frame._tag} [${frame.source}]: ${chunk}`;
        yield* renderer.output.stdout(`${text}\n`);
      });
      const flush = Effect.fnUntraced(function* (): Effect.fn.Return<void> {
        // Raw leftover is only for a redirected non-UTF-8 tail. A TTY stays on
        // the redacting text path; its decoder is non-fatal.
        if (isTty || format === "yaml") return;
        for (const [tag, decoder] of [
          ["stdout", stdoutUtf8],
          ["stderr", stderrUtf8],
        ] as const) {
          const leftover = decoder.flush();
          if (leftover === undefined) continue;
          if (!writeRaw(tag, leftover)) {
            const fallback = new TextDecoder().decode(leftover);
            yield* tag === "stderr" ? renderer.output.stderr(fallback) : renderer.output.stdout(fallback);
          }
        }
      });
      return StreamFrameSink.of({ emit, flush });
    }),
  );
