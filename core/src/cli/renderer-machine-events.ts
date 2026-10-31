import { writeResultLine } from "@lando/renderer/output";
import {
  PostBootstrapAppEvent,
  PostBootstrapCommandsEvent,
  PostBootstrapEvent,
  PostBootstrapMinimalEvent,
  PostBootstrapPluginsEvent,
  PostBootstrapProviderEvent,
  PostBootstrapToolingEvent,
  PreBootstrapAppEvent,
  PreBootstrapCommandsEvent,
  PreBootstrapMinimalEvent,
  PreBootstrapPluginsEvent,
  PreBootstrapProviderEvent,
  PreBootstrapToolingEvent,
  ReadyEvent,
} from "@lando/sdk/events";
import type { Redactor } from "@lando/sdk/secrets";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Cause, Effect, Exit, Fiber, Queue, Schema } from "effect";

// Only frame delivery filters these schema-owned tags; before-exit remains visible.
const isBootstrapMarker = Schema.is(
  Schema.Union([
    PreBootstrapMinimalEvent.fields._tag,
    PostBootstrapMinimalEvent.fields._tag,
    PreBootstrapPluginsEvent.fields._tag,
    PostBootstrapPluginsEvent.fields._tag,
    PreBootstrapCommandsEvent.fields._tag,
    PostBootstrapCommandsEvent.fields._tag,
    PreBootstrapProviderEvent.fields._tag,
    PostBootstrapProviderEvent.fields._tag,
    PreBootstrapAppEvent.fields._tag,
    PostBootstrapAppEvent.fields._tag,
    PreBootstrapToolingEvent.fields._tag,
    PostBootstrapToolingEvent.fields._tag,
    PostBootstrapEvent.fields._tag,
    ReadyEvent.fields._tag,
  ]),
);

export const startMachineEventConsumer = Effect.fnUntraced(function* (
  encodeEventFrame: (event: LandoEvent, redactor: Redactor) => Effect.Effect<string>,
  redactor: Redactor,
) {
  const events = yield* EventService;
  const subscription = yield* events.subscribeWithHistory({ capacity: 1024 });
  const { queue } = subscription;
  const emitQueuedEvent = Effect.fnUntraced(function* (event: LandoEvent) {
    if (isBootstrapMarker(event._tag)) return;
    const line = yield* encodeEventFrame(event, redactor);
    yield* writeResultLine(line);
  });
  for (const event of subscription.history) yield* emitQueuedEvent(event);
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
      yield* subscription.stop;
      retiring = true;
      // Interrupt only the pending take: a completed take still owns an event that must be written.
      if (taking !== undefined) yield* Fiber.interrupt(taking);
      yield* Fiber.join(worker);
      return yield* subscription.dropped;
    }),
  );
});
