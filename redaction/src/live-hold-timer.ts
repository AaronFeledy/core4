/**
 * One earliest-deadline timer for a live output sink.
 *
 * A sink reports the earliest hold deadline across its channels; this module
 * keeps at most one sleeping fiber per sink and replaces it when an earlier
 * deadline appears. Every schedule call runs under the sink's semaphore, so
 * channel state, timer ownership, and the finished flag change atomically.
 * The fiber sleeps on Effect's `Clock` (so `TestClock` drives it), wakes under
 * the same semaphore, and asks the sink to expire due holds. Callers interrupt
 * a superseded fiber only after releasing the semaphore, and `close` owns the
 * timer scope so no fiber survives `finish`.
 */
import { Duration, Effect, Exit, Fiber, Scope, type Semaphore } from "effect";

interface LiveHoldTimer {
  /** Call under the sink semaphore; returns a superseded timer to interrupt after release. */
  readonly schedule: () => Effect.Effect<Fiber.Fiber<void> | undefined>;
  readonly interrupt: (fiber: Fiber.Fiber<void> | undefined) => Effect.Effect<void>;
  /** Idempotent; closes the owned timer scope. */
  readonly close: () => Effect.Effect<void>;
}

interface LiveHoldTimerOptions {
  readonly lock: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  /** Refreshes the caller's clock snapshot; the sink's `now` closure reads it. */
  readonly refreshNow: Effect.Effect<void>;
  readonly now: () => number;
  readonly deadline: () => number | undefined;
  /** Runs under the semaphore with the clock refreshed. */
  readonly expire: Effect.Effect<void>;
  readonly isFinished: () => boolean;
}

export const makeLiveHoldTimer = (options: LiveHoldTimerOptions): LiveHoldTimer => {
  let timer: { readonly deadline: number; readonly fiber: Fiber.Fiber<void> } | undefined;
  let closed = false;

  const interrupt = (fiber: Fiber.Fiber<void> | undefined) =>
    fiber === undefined ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.asVoid);

  const schedule: () => Effect.Effect<Fiber.Fiber<void> | undefined> = Effect.fnUntraced(function* () {
    const deadline = options.deadline();
    if (closed || options.isFinished() || deadline === undefined) {
      const stale = timer?.fiber;
      timer = undefined;
      return stale;
    }
    if (timer !== undefined && timer.deadline === deadline) return undefined;
    const stale = timer?.fiber;
    const fiber = yield* Effect.forkIn(
      Effect.suspend(() => tick(deadline)),
      options.scope,
    );
    timer = { deadline, fiber };
    return stale;
  });

  const tick: (deadline: number) => Effect.Effect<void> = Effect.fnUntraced(function* (deadline: number) {
    yield* options.refreshNow;
    const wait = deadline - options.now();
    if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
    let stale: Fiber.Fiber<void> | undefined;
    yield* options.lock.withPermits(1)(
      Effect.gen(function* () {
        if (timer?.deadline !== deadline) return;
        timer = undefined;
        if (options.isFinished()) return;
        yield* options.refreshNow;
        yield* options.expire;
        stale = yield* schedule();
      }),
    );
    yield* interrupt(stale);
  });

  return {
    schedule,
    interrupt,
    close: () => {
      if (closed) return Effect.void;
      closed = true;
      return Scope.close(options.scope, Exit.void);
    },
  };
};
