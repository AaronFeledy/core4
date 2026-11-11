import { defineTransitions, illegalTransitionMessage, planTransition } from "@lando/sdk/transitions";
import { Effect, Semaphore } from "effect";
import { acquisitionError } from "./errors.ts";

type LeasePhase = "absent" | "open" | "released";

/** A scoped lease is a real lifecycle, even though release unlinks its file.
 * The session mutex encloses each check and write; registration additionally
 * holds the shared store lock so GC cannot retire an entry before it is leased.
 * PID liveness is a separate observation used only by GC after a process dies.
 */
export const leaseTransitions = defineTransitions<LeasePhase>()({
  initialize: { from: ["absent"], to: "open" },
  use: { from: ["open"] },
  release: { from: ["open"], to: "released", settledIn: ["released"] },
});

export const makeLeaseLifecycle = () => {
  let phase: LeasePhase = "absent";
  const mutex = Semaphore.makeUnsafe(1);
  return <A, E>(operation: keyof typeof leaseTransitions.edges, body: Effect.Effect<A, E>) =>
    mutex.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const plan = planTransition(leaseTransitions, operation, phase, (to) => to);
          switch (plan._tag) {
            case "Illegal":
              return yield* Effect.fail(
                acquisitionError(
                  "cache",
                  "lease",
                  illegalTransitionMessage("Source session", operation, plan.verdict),
                ),
              );
            case "Keep":
              return yield* body;
            case "Write": {
              // The phase commits only after the lease file operation succeeds.
              const result = yield* body;
              phase = plan.to;
              return result;
            }
          }
        }),
      ),
    );
};
