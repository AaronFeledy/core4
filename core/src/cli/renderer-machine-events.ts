import { writeResultLine } from "@lando/renderer/output";
import type { Redactor } from "@lando/sdk/secrets";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Cause, Effect, Exit, Fiber, Queue } from "effect";

export const startMachineEventConsumer = Effect.fnUntraced(function* (
  encodeEventFrame: (event: LandoEvent, redactor: Redactor) => Effect.Effect<string>,
  redactor: Redactor,
) {
  const events = yield* EventService;
  // Subscribe before the snapshot so nothing published during replay is lost; the
  // watermark drops queued copies of replayed events until the first new one.
  const queue = yield* events.subscribeQueue;
  let replayed: Set<string> | undefined = new Set();
  for (const event of yield* events.query("*")) {
    const line = yield* encodeEventFrame(event, redactor);
    replayed.add(line);
    yield* writeResultLine(line);
  }
  const emitQueuedEvent = Effect.fnUntraced(function* (event: LandoEvent) {
    const line = yield* encodeEventFrame(event, redactor);
    if (replayed?.has(line)) return;
    replayed = undefined;
    yield* writeResultLine(line);
  });
  let retiring = false;
  let taking: Fiber.Fiber<LandoEvent> | undefined;
  const worker = yield* Effect.forkScoped(
    Effect.gen(function* () {
      while (!retiring) {
        taking = yield* Effect.forkChild(Queue.take(queue));
        if (retiring) yield* Fiber.interrupt(taking);
        const next = yield* Fiber.await(taking);
        taking = undefined;
        if (Exit.isFailure(next)) {
          if (retiring && Cause.hasInterruptsOnly(next.cause)) break;
          return yield* Effect.failCause(next.cause);
        }
        yield* emitQueuedEvent(next.value);
      }
      for (const event of yield* Queue.clear(queue)) yield* emitQueuedEvent(event);
    }),
  );
  return yield* Effect.cached(
    Effect.gen(function* () {
      retiring = true;
      // Interrupt only the pending take: a completed take still owns an event that must be written.
      if (taking !== undefined) yield* Fiber.interrupt(taking);
      yield* Fiber.join(worker);
    }),
  );
});
