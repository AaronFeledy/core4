/**
 * The invocation's event-rendering consumer, kept across terminal handoffs.
 *
 * Lending the terminal to sudo's prompt needs more than a drain: once any task tree has drawn,
 * the live region keeps stdin in raw mode, which would swallow the password. So a handoff closes
 * the current consumer (which renders every event it already holds, then releases the terminal)
 * and builds a fresh one after the prompt. The handoff itself loses and repeats nothing:
 * - the old consumer's subscriptions are sealed in one synchronous step, so it renders exactly
 *   the events published before the handoff;
 * - every later event is captured from publication (which runs in the publishing fiber) until
 *   the new consumer has subscribed, and each new subscription starts with that whole capture:
 *   it is sized to hold every captured event on top of the usual live room, so a long prompt
 *   cannot overflow it. Live delivery afterwards keeps its usual bound, as for any consumer.
 * A tree that is still open cannot continue in a new consumer, so that case retires progress for
 * the rest of the run instead. A handoff inside another handoff (or two at once) lends the terminal
 * once: the consumer is rebuilt when the last one gives it back.
 */
import { DEFAULT_DELIVERY_QUEUE_CAPACITY } from "@lando/engine/services/event-service";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Context, Effect, Exit, Layer, Queue, References, Scope, Semaphore } from "effect";

import type { CommandProgressSuspension } from "./command-progress.ts";

export interface CommandProgressConsumer {
  /** Retire progress for the rest of the run. Idempotent. */
  readonly finish: Effect.Effect<void>;
  readonly suspension: CommandProgressSuspension;
  /** Feed one committed event, synchronously with delivery. */
  readonly observe: (event: LandoEvent) => void;
}

export const startCommandProgressConsumer = Effect.fnUntraced(function* (
  layer: Layer.Layer<never, never, EventService>,
): Effect.fn.Return<CommandProgressConsumer, never, EventService | Scope.Scope> {
  const events = yield* EventService;
  const parent = yield* Effect.scope;
  const invocationContext = yield* Effect.context<never>();
  const lock = yield* Semaphore.make(1);
  const openTrees = new Map<string, number>();
  const subscriptions = new Set<Queue.Queue<unknown, unknown>>();
  let captured: LandoEvent[] | undefined;
  let retired = false;
  let lent = 0;

  const subscribeQueue = Effect.gen(function* () {
    const backlog = captured ?? [];
    const queue =
      backlog.length === 0
        ? yield* events.subscribeQueue
        : (yield* events.subscribeWithHistory({ capacity: DEFAULT_DELIVERY_QUEUE_CAPACITY + backlog.length }))
            .queue;
    // Subscriptions are handed out read-only; the queue behind each is also writable.
    const writable: unknown = queue;
    if (Queue.isQueue(writable)) {
      for (const event of backlog) Queue.offerUnsafe(writable, event);
      subscriptions.add(writable);
      yield* Effect.addFinalizer(() => Effect.sync(() => subscriptions.delete(writable)));
    }
    return queue;
  }).pipe(
    // The event bus registers queues synchronously. Do not yield between reading
    // the backlog, registering the live queue, and seeding it.
    Effect.provideService(References.PreventSchedulerYield, true),
  );
  const consumerEvents = EventService.of({ ...events, subscribeQueue });
  const consumerContext = Context.add(invocationContext, EventService, consumerEvents);

  const build = Effect.gen(function* () {
    const scope = yield* Scope.fork(parent, "sequential");
    yield* Layer.buildWithScope(layer, scope).pipe(Effect.setContext(consumerContext));
    return scope;
  });
  let generation = yield* build;

  const finish = lock.withPermits(1)(
    Effect.suspend(() => {
      if (retired) return Effect.void;
      retired = true;
      return Scope.close(generation, Exit.void);
    }),
  );

  const handOff = lock.withPermits(1)(
    Effect.suspend(() => {
      if (retired) return Effect.succeed(false);
      if (lent === 0 && [...openTrees.values()].some((count) => count > 0)) {
        retired = true;
        return Effect.as(Scope.close(generation, Exit.void), false);
      }
      lent += 1;
      if (lent > 1) return Effect.succeed(true);
      captured = [];
      for (const queue of subscriptions) Queue.endUnsafe(queue);
      return Effect.as(Scope.close(generation, Exit.void), true);
    }),
  );

  const resume = lock.withPermits(1)(
    Effect.gen(function* () {
      lent -= 1;
      if (lent > 0) return;
      if (!retired) generation = yield* build;
      captured = undefined;
    }),
  );

  const suspend = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      handOff,
      () => body,
      (didLend) => (didLend ? resume : Effect.void),
    );

  const observe = (event: LandoEvent): void => {
    captured?.push(event);
    if (event._tag === "task.tree.start" || event._tag === "task.tree.complete") {
      const id = Reflect.get(event, "parentId");
      if (typeof id !== "string") return;
      const delta = event._tag === "task.tree.start" ? 1 : -1;
      openTrees.set(id, (openTrees.get(id) ?? 0) + delta);
    }
  };

  return { finish, suspension: { suspend }, observe };
});
