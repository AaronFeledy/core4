import { DateTime, Effect, Fiber, Layer, Option, Queue } from "effect";

import { MessageErrorEvent, MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import type { RendererCapabilities, RendererIO, RendererNarrationIO } from "@lando/sdk/renderer";
import { EventService, type LandoEvent, Renderer } from "@lando/sdk/services";

import { waitForRendererOutput } from "@lando/renderer/output-drain";
import { renderLandoLine } from "./format.ts";
import { outputJournalFor } from "./renderer-output-journal.ts";

const layerEventConsumer = (handle: (event: LandoEvent) => void): Layer.Layer<never, never, EventService> =>
  Layer.effectDiscard(
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
          const remaining = yield* Queue.clear(queue).pipe(Effect.option);
          if (Option.isSome(remaining)) {
            for (const event of remaining.value) handle(event);
          }
          yield* Fiber.interrupt(fiber);
        }),
      );
    }),
  );

const nowTimestamp = (): DateTime.Utc => DateTime.nowUnsafe();

const makeMessageContract = (io: RendererNarrationIO, color: boolean) => {
  const output = outputJournalFor(io);
  const emit = (event: LandoEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      const line = renderLandoLine(event, io.isTTY === true, io.terminalColumns, color);
      if (line !== null) output.writeStderr(`${line}\n`);
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
      return Renderer.of({
        id: "lando",
        get capabilities() {
          return getCapabilities();
        },
        message: makeMessageContract(io, getCapabilities().color),
        output: {
          stdout: (chunk: string | Uint8Array) =>
            Effect.sync(() =>
              output.writeOutput(chunk, () => io.writeStdout(chunk), io.stdoutIsTTY === true),
            ).pipe(Effect.andThen(waitForRendererOutput(io, "stdout"))),
          stderr: (chunk: string | Uint8Array) =>
            Effect.sync(() => output.writeOutput(chunk, () => io.writeStderr(chunk), io.isTTY === true)).pipe(
              Effect.andThen(waitForRendererOutput(io, "stderr")),
            ),
        },
      });
    })(),
  );

export const makeLineModeConsumer = (
  io: RendererNarrationIO,
  color: boolean,
): Layer.Layer<never, never, EventService> =>
  layerEventConsumer((event) => {
    const line = renderLandoLine(event, io.isTTY === true, io.terminalColumns, color);
    if (line !== null) io.writeStderr(`${line}\n`);
  });
