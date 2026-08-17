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
import {
  makeJsonNotificationRendererLive,
  makeJsonRendererLive,
  makeJsonRendererServiceLive,
  makePlainRendererLive,
  makePlainRendererServiceLive,
  makePlainTaskDetailRendererLive,
  makeVerboseRendererLive,
  makeVerboseRendererServiceLive,
} from "./runtime.ts";

type RendererMode = "lando" | "json" | "plain" | "verbose";

export const makeRendererServiceLiveForMode = (
  mode: RendererMode,
  landoRenderer: RendererContribution,
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
  readonly landoRenderer: RendererContribution;
  readonly plainTaskEvents?: "detail-only";
}

export const makeRendererEventConsumerLiveForMode = (
  mode: RendererMode,
  io: RendererIO,
  options: RendererEventConsumerOptions,
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
      return options.landoRenderer.makeEventConsumer(io);
  }
};

export const makeRendererNotificationConsumerLiveForMode = (
  mode: RendererMode,
  landoRenderer: RendererContribution,
  io: RendererIO,
): Layer.Layer<never, never, EventService> | undefined => {
  switch (mode) {
    case "json":
      return makeJsonNotificationRendererLive(io);
    case "lando":
      return landoRenderer.makeEventConsumer({
        writeStdout: () => {},
        writeStderr: () => {},
        ...(io.isTTY === undefined ? {} : { isTTY: io.isTTY }),
      });
    case "plain":
    case "verbose":
      return undefined;
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
      ? Effect.dieMessage("Renderer not provided at the CLI command boundary")
      : Effect.succeed(option.value),
  ),
);

export const writeStdout = (chunk: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(chunk)));

export const writeResultLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(`${text}\n`)));

export const writeDiagnosticLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stderr(`${text}\n`)));

export const makeStreamFrameSinkLive = (
  format: CommandResultFormat,
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
