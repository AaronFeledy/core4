import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { type RootOverrides, makeLandoPaths } from "@lando/paths";
import { defineTransitions, illegalTransitionMessage } from "@lando/sdk/transitions";
import { withAdvisoryLockUsing } from "@lando/state-store/lock";
import { resolveStatePath } from "@lando/state-store/paths";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, Ref, Schema, Semaphore } from "effect";

export type WorkerClaimState = "absent" | "starting" | "ready" | "stopping";

// Only absence or a published ready record survives the lock. Starting/stopping
// describe the exclusive operation in progress, not new fields in worker.json.
// A published record is a claim, never evidence that its process is still alive.
const transitions = defineTransitions<WorkerClaimState>()({
  spawn: { from: ["absent"], to: "starting" },
  publish: { from: ["absent", "starting"], to: "ready" },
  reuse: { from: ["ready"] },
  stop: { from: ["ready"], to: "stopping" },
  remove: { from: ["stopping"], to: "absent", settledIn: ["absent"] },
  "reap-stale": { from: ["ready", "starting"], to: "absent", settledIn: ["absent"] },
});
export type WorkerClaimOperation = keyof typeof transitions.edges;

export const planWorkerClaim = (operation: WorkerClaimOperation, state: WorkerClaimState) =>
  transitions.step(operation, state);

export class WorkerClaimError extends Schema.TaggedError<WorkerClaimError>()("WorkerClaimError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

export interface WorkerLockOptions {
  readonly path: string;
  readonly label: string;
  readonly paths: RootOverrides | undefined;
  readonly privateFileAccess: PrivateFileAccess;
}

/**
 * Authority over one worker record, granted only to the body of the record's advisory
 * lock. The private constructor is the proof: every record mutation takes a claim, so a
 * mutation outside the lock does not compile. Nested operations receive the same claim
 * instead of relocking, because the in-process lock guard is not reentrant. The claim is
 * revoked before the lock is released, so a claim that escapes its body cannot write, and
 * one claim runs one check-and-mutate at a time.
 */
export class WorkerClaim {
  readonly #state: Ref.Ref<WorkerClaimState>;
  readonly #held: Ref.Ref<boolean>;
  readonly #gate: Semaphore.Semaphore;

  private constructor(
    readonly path: string,
    state: Ref.Ref<WorkerClaimState>,
    held: Ref.Ref<boolean>,
  ) {
    this.#state = state;
    this.#held = held;
    this.#gate = Semaphore.makeUnsafe(1);
  }

  static hold<A, E>(options: WorkerLockOptions, body: (claim: WorkerClaim) => Effect.Effect<A, E>) {
    const key = `${options.label}-${createHash("sha256")
      .update(resolve(dirname(options.path)))
      .digest("hex")}`;
    const claimed = Effect.gen(function* () {
      const present = yield* Effect.promise(() => Bun.file(options.path).exists());
      const state = yield* Ref.make<WorkerClaimState>(present ? "ready" : "absent");
      const held = yield* Ref.make(true);
      return yield* body(new WorkerClaim(options.path, state, held)).pipe(
        Effect.ensuring(Ref.set(held, false)),
      );
    });
    return resolveStatePath(
      "userData",
      "operation-locks",
      key,
      options.label,
      makeLandoPaths(options.paths).roots,
    ).pipe(
      Effect.flatMap(({ file }) =>
        withAdvisoryLockUsing(options.privateFileAccess, { expireLiveOwner: false })(
          file,
          options.label,
          claimed,
        ),
      ),
    );
  }

  static readonly change = Effect.fnUntraced(function* <A, E>(
    claim: WorkerClaim,
    operation: WorkerClaimOperation,
    mutation: Effect.Effect<A, E>,
  ) {
    return yield* claim.#gate.withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* Ref.get(claim.#held)))
          return yield* Effect.fail(
            new WorkerClaimError({
              message: `Detached worker claim for ${claim.path} was used after its lock was released.`,
              remediation: "Run the worker operation inside the body that holds the record lock.",
            }),
          );
        const verdict = planWorkerClaim(operation, yield* Ref.get(claim.#state));
        switch (verdict._tag) {
          case "Illegal":
            return yield* Effect.fail(
              new WorkerClaimError({
                message: illegalTransitionMessage("Detached worker", operation, verdict),
                remediation: "Reconcile the existing worker claim before retrying.",
              }),
            );
          case "Settled":
            // Artifact cleanup still runs for an absent record (crash before publication).
            return yield* mutation;
          case "Advance": {
            const result = yield* mutation;
            yield* Ref.set(claim.#state, verdict.to);
            return result;
          }
        }
      }),
    );
  });
}

/** Runs `body` under the record's advisory lock and hands it the record's claim. */
export const withDetachedWorkerLock = WorkerClaim.hold;

/** Checks and mutates inside the locked critical section that `claim` proves. */
export const changeWorkerClaim = WorkerClaim.change;
