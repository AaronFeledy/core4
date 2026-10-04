import { DateTime, Effect, Fiber, Layer, Option, Queue } from "effect";

import { MessageErrorEvent, MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import {
  RENDERER_CAPABILITIES_NONE,
  RENDERER_CAPABILITIES_VERBOSE_TTY,
  type RendererCapabilities,
  isRenderableTaskTreeEvent,
  renderJsonLine,
  renderPlainLine,
  renderVerboseLine,
} from "@lando/sdk/renderer";
import { EventService, type LandoEvent, Renderer } from "@lando/sdk/services";

import type { RendererIO } from "./io.ts";

type LineFormatter = (event: LandoEvent) => string | null;

const layerEventConsumer = (handle: (event: LandoEvent) => void): Layer.Layer<never, never, EventService> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const events = yield* EventService;
      const queue = yield* events.subscribeQueue;
      const consumer = Effect.gen(function* () {
        while (true) {
          handle(yield* Queue.take(queue));
        }
      });
      const fiber = yield* Effect.forkScoped(consumer);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Fiber.interrupt(fiber);
          const remaining = yield* Queue.clear(queue).pipe(Effect.option);
          if (Option.isSome(remaining)) {
            for (const event of remaining.value) handle(event);
          }
        }),
      );
    }),
  );

const layerRenderer = (
  formatter: LineFormatter,
  io: RendererIO,
  destination: "stdout" | "stderr",
): Layer.Layer<never, never, EventService> => {
  const write = destination === "stderr" ? io.writeStderr : io.writeStdout;
  return layerEventConsumer((event) => {
    const line = formatter(event);
    if (line !== null) write(`${line}\n`);
  });
};

const renderPlainTaskDetailLine = (event: LandoEvent): string | null => {
  if (isRenderableTaskTreeEvent(event) && event._tag !== "task.detail") return null;
  return renderPlainLine(event);
};

export const layerPlain = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  layerRenderer(renderPlainLine, io, "stdout");

export const layerPlainTaskDetail = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  layerRenderer(renderPlainTaskDetailLine, io, "stdout");

export const layerJson = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  layerRenderer(renderJsonLine, io, "stderr");

export const layerJsonNotification = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  layerRenderer((event) => (event._tag === "notify.desktop" ? JSON.stringify(event) : null), io, "stderr");

export const layerVerbose = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  layerRenderer(renderVerboseLine, io, "stdout");

export const drainRendererSync = (
  formatter: LineFormatter,
  io: RendererIO,
  destination: "stdout" | "stderr",
  events: ReadonlyArray<LandoEvent>,
): void => {
  const write = destination === "stderr" ? io.writeStderr : io.writeStdout;
  for (const event of events) {
    const line = formatter(event);
    if (line !== null) write(`${line}\n`);
  }
};

export const renderPlain = (io: RendererIO, events: ReadonlyArray<LandoEvent>): void =>
  drainRendererSync(renderPlainLine, io, "stdout", events);

export const renderJson = (io: RendererIO, events: ReadonlyArray<LandoEvent>): void =>
  drainRendererSync(renderJsonLine, io, "stderr", events);

const nowTimestamp = (): DateTime.Utc => DateTime.nowUnsafe();

/**
 * Build a renderer's `message.{info,warn,error}` contract: each severity is
 * encoded as the canonical `message.*` event, formatted by the mode's line
 * formatter, and written to the mode's destination stream. The output is
 * byte-identical to the event-consumer path so imperative and published
 * messages render the same way.
 */
const makeMessageContract = (formatter: LineFormatter, io: RendererIO, destination: "stdout" | "stderr") => {
  const write = destination === "stderr" ? io.writeStderr : io.writeStdout;
  const emit = (event: LandoEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      const line = formatter(event);
      if (line !== null) write(`${line}\n`);
    });
  return {
    info: (body: string): Effect.Effect<void> =>
      emit(MessageInfoEvent.make({ body, timestamp: nowTimestamp() })),
    warn: (body: string): Effect.Effect<void> =>
      emit(MessageWarnEvent.make({ body, timestamp: nowTimestamp() })),
    error: (body: string, remediation?: string): Effect.Effect<void> =>
      emit(
        MessageErrorEvent.make(
          remediation === undefined
            ? { body, timestamp: nowTimestamp() }
            : { body, remediation, timestamp: nowTimestamp() },
        ),
      ),
  };
};

/**
 * Raw `output.{stdout,stderr}` channel: chunks are written verbatim (no glyph
 * or newline injection), unlike `message.*`. Carries already-formatted command
 * results (stdout) and process-level failure diagnostics (stderr).
 */
const makeOutputChannel = (io: RendererIO) => ({
  stdout: (chunk: string): Effect.Effect<void> => Effect.sync(() => io.writeStdout(chunk)),
  stderr: (chunk: string): Effect.Effect<void> => Effect.sync(() => io.writeStderr(chunk)),
});

const capabilitiesForFallback = (id: "plain" | "json" | "verbose", io: RendererIO): RendererCapabilities => {
  if (id === "verbose" && io.isTTY === true) return RENDERER_CAPABILITIES_VERBOSE_TTY;
  return RENDERER_CAPABILITIES_NONE;
};

export const makePlainRenderer = (io: RendererIO) =>
  Renderer.of({
    id: "plain" as const,
    get capabilities(): RendererCapabilities {
      return capabilitiesForFallback("plain", io);
    },
    message: makeMessageContract(renderPlainLine, io, "stdout"),
    output: makeOutputChannel(io),
  });

export const makeJsonRenderer = (io: RendererIO) =>
  Renderer.of({
    id: "json" as const,
    get capabilities(): RendererCapabilities {
      return capabilitiesForFallback("json", io);
    },
    message: makeMessageContract(renderJsonLine, io, "stderr"),
    output: makeOutputChannel(io),
  });

export const makeVerboseRenderer = (io: RendererIO) =>
  Renderer.of({
    id: "verbose" as const,
    get capabilities(): RendererCapabilities {
      return capabilitiesForFallback("verbose", io);
    },
    message: makeMessageContract(renderVerboseLine, io, "stdout"),
    output: makeOutputChannel(io),
  });

export const layerPlainService = (io: RendererIO): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer, makePlainRenderer(io));

export const layerJsonService = (io: RendererIO): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer, makeJsonRenderer(io));

export const layerVerboseService = (io: RendererIO): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer, makeVerboseRenderer(io));
