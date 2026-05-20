import { Effect, Fiber, Layer, Option, Queue } from "effect";

import { EventService, type LandoEvent } from "@lando/sdk/services";

import { renderJsonLine, renderPlainLine } from "./format.ts";
import type { RendererIO } from "./io.ts";

type LineFormatter = (event: LandoEvent) => string | null;

const makeRendererLive = (
  formatter: LineFormatter,
  io: RendererIO,
  destination: "stdout" | "stderr",
): Layer.Layer<never, never, EventService> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* EventService;
      const queue = yield* events.subscribeQueue;
      const write = destination === "stderr" ? io.writeStderr : io.writeStdout;
      const consumer = Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          const line = formatter(event);
          if (line !== null) write(`${line}\n`);
        }
      });
      const fiber = yield* Effect.forkScoped(consumer);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const remaining = yield* Queue.takeAll(queue).pipe(Effect.option);
          if (Option.isSome(remaining)) {
            for (const event of remaining.value) {
              const line = formatter(event);
              if (line !== null) write(`${line}\n`);
            }
          }
          yield* Fiber.interrupt(fiber);
        }),
      );
    }),
  );

export const makePlainRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makeRendererLive(renderPlainLine, io, "stdout");

export const makeJsonRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makeRendererLive(renderJsonLine, io, "stderr");

export const makeLandoRendererLive = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makePlainRendererLive(io);

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
