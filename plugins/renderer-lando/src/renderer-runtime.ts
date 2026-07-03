import { DateTime, Effect, Fiber, Layer, Option, Queue, Runtime } from "effect";

import { MessageErrorEvent, MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import type { RendererContribution, RendererIO } from "@lando/sdk/renderer";
import { EventService, type LandoEvent, Renderer } from "@lando/sdk/services";

import { isRenderableTaskTreeEvent, renderPlainLine } from "./format.ts";
import { TaskTreeInputController } from "./keybindings.ts";
import { LandoTreePainter } from "./task-tree-tail.ts";

/**
 * Wrap a synchronous per-event handler in the `EventService`
 * subscription/drain layer: events are consumed in order and any queued
 * remainder is flushed on scope close before the consumer fiber is interrupted.
 */
const makeEventConsumerLive = (
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

const nowTimestamp = (): DateTime.Utc => DateTime.unsafeMake(new Date().toISOString());

/**
 * Build the `message.{info,warn,error}` contract: each severity is encoded as
 * the canonical `message.*` event, formatted by the plain line formatter, and
 * written to stdout so imperative and published messages render identically.
 */
const makeMessageContract = (io: RendererIO) => {
  const emit = (event: LandoEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      const line = renderPlainLine(event);
      if (line !== null) io.writeStdout(`${line}\n`);
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
 * or newline injection), carrying already-formatted command results (stdout)
 * and process-level failure diagnostics (stderr).
 */
const makeOutputChannel = (io: RendererIO) => ({
  stdout: (chunk: string): Effect.Effect<void> => Effect.sync(() => io.writeStdout(chunk)),
  stderr: (chunk: string): Effect.Effect<void> => Effect.sync(() => io.writeStderr(chunk)),
});

/**
 * Bind the TTY keyboard-input layer to a painter: raw keypress chunks drive the
 * `TaskTreeInputController`, redraw output is written to stdout, and any emitted
 * focus/expand/collapse events are published back onto the bus.
 */
const makeTaskTreeInputLive = (
  io: RendererIO,
  painter: LandoTreePainter,
): Layer.Layer<never, never, EventService> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const subscribe = io.subscribeInput;
      if (subscribe === undefined) return;
      const events = yield* EventService;
      const runtime = yield* Effect.runtime<never>();
      const controller = new TaskTreeInputController(painter);
      const unsubscribe = subscribe((raw) => {
        const result = controller.handleInput(raw);
        if (!result.changed) return;
        if (result.redraw.length > 0) io.writeStdout(result.redraw);
        for (const event of result.events) Runtime.runFork(runtime)(events.publish(event));
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    }),
  );

const makeLandoService = (io: RendererIO): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer, {
    id: "lando",
    message: makeMessageContract(io),
    output: makeOutputChannel(io),
  });

const makeLandoEventConsumer = (io: RendererIO): Layer.Layer<never, never, EventService> => {
  if (io.isTTY !== true) {
    return makeEventConsumerLive((event) => {
      const line = renderPlainLine(event);
      if (line !== null) io.writeStdout(`${line}\n`);
    });
  }
  const painter = new LandoTreePainter({
    getTerminalColumns: () => io.terminalColumns,
    getTerminalRows: () => io.terminalRows,
  });
  const display = makeEventConsumerLive((event) => {
    if (isRenderableTaskTreeEvent(event)) {
      io.writeStdout(painter.consume(event));
      return;
    }
    const line = renderPlainLine(event);
    if (line !== null) io.writeStdout(painter.passthrough(line));
  });
  return io.subscribeInput === undefined ? display : Layer.merge(display, makeTaskTreeInputLive(io, painter));
};

/**
 * The default `lando` renderer contribution: the task-tree painter and event
 * consumer, the `Renderer` service (plain message contract + raw output
 * channel), and the non-TTY plain fallback. This is the maintained first-party
 * reference implementation renderer-plugin authors follow.
 */
export const landoRendererContribution: RendererContribution = {
  id: "lando",
  makeService: (io) => makeLandoService(io),
  makeEventConsumer: (io) => makeLandoEventConsumer(io),
};
