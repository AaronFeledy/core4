import { DateTime, Effect, Fiber, Layer, Option, Queue } from "effect";

import { MessageErrorEvent, MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import type { RendererCapabilities, RendererIO } from "@lando/sdk/renderer";
import { EventService, type LandoEvent, Renderer } from "@lando/sdk/services";

import { renderPlainLine } from "./format.ts";
import { outputJournalFor } from "./renderer-output-journal.ts";

const makeEventConsumerLive = (
  handle: (event: LandoEvent) => void,
): Layer.Layer<never, never, EventService> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* EventService;
      const queue = yield* events.subscribeQueue;
      const fiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) handle(yield* Queue.take(queue));
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const remaining = yield* Queue.takeAll(queue).pipe(Effect.option);
          if (Option.isSome(remaining)) for (const event of remaining.value) handle(event);
          yield* Fiber.interrupt(fiber);
        }),
      );
    }),
  );

const nowTimestamp = (): DateTime.Utc => DateTime.unsafeMake(new Date().toISOString());

const makeMessageContract = (io: RendererIO) => {
  const output = outputJournalFor(io);
  const emit = (event: LandoEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      const line = renderPlainLine(event);
      if (line !== null) output.writeStdout(`${line}\n`);
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

export const makeLandoService = (
  io: RendererIO,
  getCapabilities: () => RendererCapabilities,
): Layer.Layer<Renderer> =>
  Layer.succeed(
    Renderer,
    (() => {
      const output = outputJournalFor(io);
      return {
        id: "lando",
        get capabilities() {
          return getCapabilities();
        },
        message: makeMessageContract(io),
        output: {
          stdout: (chunk: string) => Effect.sync(() => output.writeStdout(chunk)),
          stderr: (chunk: string) => Effect.sync(() => output.writeStderr(chunk)),
        },
      };
    })(),
  );

export const makeLineModeConsumer = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makeEventConsumerLive((event) => {
    const line = renderPlainLine(event);
    if (line !== null) io.writeStdout(`${line}\n`);
  });
