import { Effect, Exit, Queue } from "effect";

/**
 * Drain currently buffered dequeue messages without waiting.
 *
 * `Queue.takeAll` suspends until at least one message is available
 * (it returns `NonEmptyArray`). Scope finalizers and test collectors need the
 * currently buffered messages, including an empty result.
 */
export const takeAllAvailable = <A, E = never>(queue: Queue.Dequeue<A, E>): Effect.Effect<ReadonlyArray<A>> =>
  Effect.sync(() => {
    const out: A[] = [];
    for (;;) {
      const next = Queue.takeUnsafe(queue);
      if (next === undefined) break;
      if (Exit.isSuccess(next)) out.push(next.value);
      else break;
    }
    return out;
  });
