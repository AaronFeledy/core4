import { Effect, Fiber, Layer, Option, Queue } from "effect";

import { EventService, type LandoEvent } from "@lando/sdk/services";

import { isRenderableTaskTreeEvent, renderJsonLine, renderPlainLine } from "./format.ts";
import type { RendererIO } from "./io.ts";
import { LandoTreePainter } from "./task-tree-tail.ts";

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

export const makePlainRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makeRendererLive(renderPlainLine, io, "stdout");

export const makeJsonRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makeRendererLive(renderJsonLine, io, "stderr");

const makeLandoTtyRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> => {
  const painter = new LandoTreePainter({ getTerminalColumns: () => io.terminalColumns });
  return makeEventConsumerRendererLive((event) => {
    if (isRenderableTaskTreeEvent(event)) {
      io.writeStdout(painter.consume(event));
      return;
    }
    const line = renderPlainLine(event);
    if (line !== null) io.writeStdout(painter.passthrough(line));
  });
};

export const makeLandoRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  io.isTTY === true ? makeLandoTtyRendererLive(io) : makePlainRendererLive(io);

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
