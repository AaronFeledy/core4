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

import { type EventService, Renderer } from "@lando/sdk/services";

import { RedactionService } from "../redaction/service.ts";
import type { ResultFormat } from "./format-flags.ts";
import type { RendererMode } from "./renderer-selection.ts";
import { landoRenderer, makeLandoNotificationConsumer } from "./renderer/bundled-renderers.ts";
import { type RendererIO, createStdioRendererIO } from "./renderer/io.ts";
import {
  makeJsonNotificationRendererLive,
  makeJsonRendererLive,
  makeJsonRendererServiceLive,
  makePlainRendererLive,
  makePlainRendererServiceLive,
  makePlainTaskDetailRendererLive,
  makeVerboseRendererLive,
  makeVerboseRendererServiceLive,
} from "./renderer/runtime.ts";
import { encodeStreamStderrFrame, encodeStreamStdoutFrame } from "./result-encode.ts";
import { StreamFrameSink, type StreamFrameSinkFrame } from "./stream-frame-sink.ts";

export const makeRendererServiceLiveForMode = (
  mode: RendererMode,
  io: RendererIO = createStdioRendererIO(),
): Layer.Layer<Renderer> => {
  switch (mode) {
    case "json":
      return makeJsonRendererServiceLive(io);
    case "plain":
      return makePlainRendererServiceLive(io);
    case "verbose":
      return makeVerboseRendererServiceLive(io);
    case "lando":
      return landoRenderer.makeService(io);
  }
};

export interface RendererEventConsumerOptions {
  readonly plainTaskEvents?: "detail-only";
}

export const makeRendererEventConsumerLiveForMode = (
  mode: RendererMode,
  io: RendererIO = createStdioRendererIO(),
  options: RendererEventConsumerOptions = {},
): Layer.Layer<never, never, EventService> => {
  switch (mode) {
    case "json":
      return makeJsonRendererLive(io);
    case "plain":
      return options.plainTaskEvents === "detail-only"
        ? makePlainTaskDetailRendererLive(io)
        : makePlainRendererLive(io);
    case "verbose":
      return makeVerboseRendererLive(io);
    case "lando":
      return landoRenderer.makeEventConsumer(io);
  }
};

export const makeRendererNotificationConsumerLiveForMode = (
  mode: RendererMode,
  io: RendererIO,
): Layer.Layer<never, never, EventService> | undefined => {
  switch (mode) {
    case "json":
      return makeJsonNotificationRendererLive(io);
    case "lando":
      return makeLandoNotificationConsumer(io);
    case "plain":
    case "verbose":
      return undefined;
  }
};

const requireRenderer = Effect.serviceOption(Renderer).pipe(
  Effect.flatMap((option) =>
    Option.isNone(option)
      ? Effect.dieMessage("Renderer not provided at the CLI command boundary")
      : Effect.succeed(option.value),
  ),
);

export const writeStdout = (chunk: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(chunk)));

const optionalRenderer = Effect.serviceOption(Renderer);

export const emitOptionalStdout = (chunk: string): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stdout(chunk) : Effect.void)),
  );

export const emitOptionalStderr = (chunk: string): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stderr(chunk) : Effect.void)),
  );

export const writeResultLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(`${text}\n`)));

export const writeDiagnosticLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stderr(`${text}\n`)));

export const makeStreamFrameSinkLive = (
  format: ResultFormat,
): Layer.Layer<StreamFrameSink, never, Renderer | RedactionService> =>
  Layer.effect(
    StreamFrameSink,
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const redaction = yield* RedactionService;
      const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
      const emit = (frame: StreamFrameSinkFrame): Effect.Effect<void> =>
        Effect.gen(function* () {
          const streamFrameOptions = {
            chunk: frame.chunk,
            ...(frame.service === undefined ? {} : { service: frame.service }),
            ...(frame.source === undefined ? {} : { source: frame.source }),
            redactor,
          };
          if (format === "json") {
            const line =
              frame._tag === "stdout"
                ? yield* encodeStreamStdoutFrame(streamFrameOptions)
                : yield* encodeStreamStderrFrame(streamFrameOptions);
            yield* renderer.output.stdout(`${line}\n`);
            return;
          }
          const chunk = redactor.redactString(frame.chunk);
          const text =
            frame.service === undefined
              ? chunk
              : frame.source === undefined
                ? `${frame.service} ${frame._tag}: ${chunk}`
                : `${frame.service} ${frame._tag} [${frame.source}]: ${chunk}`;
          yield* renderer.output.stdout(`${text}\n`);
        });
      return { emit };
    }),
  );
