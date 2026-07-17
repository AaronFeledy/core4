import { DateTime, Effect, Fiber, Layer, Option, Queue } from "effect";

import { MessageErrorEvent, MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import {
  RENDERER_CAPABILITIES_NONE,
  RENDERER_CAPABILITIES_VERBOSE_TTY,
  type RendererCapabilities,
} from "@lando/sdk/renderer";
import { EventService, type LandoEvent, Renderer } from "@lando/sdk/services";

import { isRenderableTaskTreeEvent, renderJsonLine, renderPlainLine, renderVerboseLine } from "./format.ts";
import type { RendererIO } from "./io.ts";

type LineFormatter = (event: LandoEvent) => string | null;

const makeEventConsumerRendererLive = (
  handle: (event: LandoEvent) => void,
): Layer.Layer<never, never, EventService> =>
  Layer.scopedDiscard(
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
          const remaining = yield* Queue.takeAll(queue).pipe(Effect.option);
          if (Option.isSome(remaining)) {
            for (const event of remaining.value) handle(event);
          }
          yield* Fiber.interrupt(fiber);
        }),
      );
    }),
  );

const makeRendererLive = (
  formatter: LineFormatter,
  io: RendererIO,
  destination: "stdout" | "stderr",
): Layer.Layer<never, never, EventService> => {
  const write = destination === "stderr" ? io.writeStderr : io.writeStdout;
  return makeEventConsumerRendererLive((event) => {
    const line = formatter(event);
    if (line !== null) write(`${line}\n`);
  });
};

const renderPlainTaskDetailLine = (event: LandoEvent): string | null => {
  if (isRenderableTaskTreeEvent(event) && event._tag !== "task.detail") return null;
  return renderPlainLine(event);
};

export const makePlainRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makeRendererLive(renderPlainLine, io, "stdout");

export const makePlainTaskDetailRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makeRendererLive(renderPlainTaskDetailLine, io, "stdout");

export const makeJsonRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makeRendererLive(renderJsonLine, io, "stderr");

export const makeVerboseRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makeRendererLive(renderVerboseLine, io, "stdout");

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

const nowTimestamp = (): DateTime.Utc => DateTime.unsafeMake(new Date().toISOString());

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

export const makePlainRenderer = (io: RendererIO) => ({
  id: "plain" as const,
  get capabilities(): RendererCapabilities {
    return capabilitiesForFallback("plain", io);
  },
  message: makeMessageContract(renderPlainLine, io, "stdout"),
  output: makeOutputChannel(io),
});

export const makeJsonRenderer = (io: RendererIO) => ({
  id: "json" as const,
  get capabilities(): RendererCapabilities {
    return capabilitiesForFallback("json", io);
  },
  message: makeMessageContract(renderJsonLine, io, "stderr"),
  output: makeOutputChannel(io),
});

export const makeVerboseRenderer = (io: RendererIO) => ({
  id: "verbose" as const,
  get capabilities(): RendererCapabilities {
    return capabilitiesForFallback("verbose", io);
  },
  message: makeMessageContract(renderVerboseLine, io, "stdout"),
  output: makeOutputChannel(io),
});

export const makePlainRendererServiceLive = (io: RendererIO): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer, makePlainRenderer(io));

export const makeJsonRendererServiceLive = (io: RendererIO): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer, makeJsonRenderer(io));

export const makeVerboseRendererServiceLive = (io: RendererIO): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer, makeVerboseRenderer(io));
