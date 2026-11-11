import { Effect, Ref } from "effect";
import { type WorkerClaim, changeWorkerClaim } from "./claim.ts";
import type { DetachedWorkerProcess } from "./process.ts";

export interface WorkerAcquisition<Ready, Session, E> {
  readonly claim: WorkerClaim;
  readonly reuse: Effect.Effect<Session | undefined, E>;
  readonly replace: Effect.Effect<void, E>;
  readonly spawn: Effect.Effect<DetachedWorkerProcess<Ready>, E>;
  readonly prepare: (worker: DetachedWorkerProcess<Ready>) => Effect.Effect<
    {
      readonly session: Session;
      readonly persist: Effect.Effect<void, E>;
    },
    E
  >;
  readonly publish: (session: Session) => Effect.Effect<void>;
}

/** The claim keeps the record locked from observation through ownership publication. */
export const acquireWorker = Effect.fnUntraced(function* <Ready, Session, E>(
  options: WorkerAcquisition<Ready, Session, E>,
) {
  const reused = yield* options.reuse;
  if (reused !== undefined)
    return yield* changeWorkerClaim(options.claim, "reuse", options.publish(reused)).pipe(Effect.as(reused));
  yield* options.replace;
  const retained = yield* Ref.make(false);
  return yield* Effect.acquireUseRelease(
    changeWorkerClaim(options.claim, "spawn", options.spawn),
    (worker) =>
      options
        .prepare(worker)
        .pipe(
          Effect.flatMap(({ session, persist }) =>
            Effect.uninterruptible(
              persist.pipe(
                Effect.andThen(Ref.set(retained, true)),
                Effect.andThen(options.publish(session)),
                Effect.as(session),
              ),
            ),
          ),
        ),
    (worker) =>
      Ref.get(retained).pipe(
        Effect.flatMap((keep) => (keep ? Effect.void : Effect.promise(() => worker.terminate()))),
      ),
  );
});

export interface WorkerTermination<E> {
  readonly claim: WorkerClaim;
  /** Ownership and identity validation must precede any shutdown request or signal. */
  readonly owned: Effect.Effect<boolean, E>;
  readonly shutdown: Effect.Effect<void, E>;
  readonly remove: Effect.Effect<void, E>;
}

/** A rejected/dead claim is reaped without granting authority to signal its PID. */
export const terminateWorker = Effect.fnUntraced(function* <E>(options: WorkerTermination<E>) {
  if (!(yield* options.owned)) return yield* changeWorkerClaim(options.claim, "reap-stale", options.remove);
  yield* changeWorkerClaim(options.claim, "stop", Effect.void);
  yield* options.shutdown;
  yield* changeWorkerClaim(options.claim, "remove", options.remove);
});

export const workerSessionLifetime = (dispose: () => Promise<void>) => {
  const closed = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  return {
    closed: closed.promise,
    close: () => {
      closing ??= dispose().finally(closed.resolve);
      return closing;
    },
  };
};
