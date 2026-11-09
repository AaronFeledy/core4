import { basename, dirname, join } from "node:path";
import { StateStoreError } from "@lando/sdk/errors";
import { FileSystem, StateStore } from "@lando/sdk/services";
import { Effect, Result, Schema } from "effect";
import {
  journalRecovery,
  pendingStartBucketSpec,
  pendingStartTransitions,
  sameStartIdentity,
} from "./accelerated-start-record.ts";

export const UnreadableStartJournal = Schema.Struct({
  path: Schema.String,
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.String,
});

const unreadableJournal = (path: string, error: StateStoreError): typeof UnreadableStartJournal.Type => ({
  path,
  _tag: error._tag,
  message: `The accelerated-start journal could not be read (${error.reason}).`,
  remediation:
    "Restore a readable journal from a trusted backup or repair its durable-state format using the Lando version that wrote it. Preserve this journal and its resources until ownership can be verified.",
});

export const readAcceleratedStartInventory = Effect.fnUntraced(function* (includeCompleted = false) {
  const store = yield* StateStore;
  const fs = yield* FileSystem;
  const probe = yield* store.open(pendingStartBucketSpec("inventory.json"));
  const keys = yield* fs.readDir(dirname(probe.path)).pipe(
    Effect.catchTag("FileNotFoundError", () => Effect.succeed([])),
    Effect.catchTag("FileIoError", (error) => {
      const cause = error.cause;
      return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOTDIR"
        ? Effect.succeed([])
        : Effect.fail(error);
    }),
  );
  const documents = yield* Effect.forEach(
    keys.filter((key) => /^[a-f0-9]{64}\.json$/u.test(key)),
    (key) =>
      Effect.gen(function* () {
        const bucket = yield* store.open(pendingStartBucketSpec(key));
        const pending = yield* bucket.get;
        return pending === null || (!includeCompleted && pending.phase === "completed")
          ? []
          : [{ ...pending, path: bucket.path, remediation: journalRecovery() }];
      }).pipe(
        Effect.result,
        Effect.map((result) => ({ key, result })),
      ),
  );
  return {
    records: documents.flatMap(({ result }) => (Result.isSuccess(result) ? result.success : [])),
    unreadable: documents.flatMap(({ key, result }): (typeof UnreadableStartJournal.Type)[] =>
      Result.isSuccess(result) ? [] : [unreadableJournal(join(dirname(probe.path), key), result.failure)],
    ),
  };
});

export const acceleratedStartInventory = readAcceleratedStartInventory();

export const sweepCompletedAcceleratedStarts = Effect.fn("AppOperation.sweepCompletedAcceleratedStarts")(
  function* (providerId?: string) {
    const inventory = yield* readAcceleratedStartInventory(true);
    const unreadable = [...inventory.unreadable];
    const store = yield* StateStore;
    let removed = 0;
    for (const record of inventory.records) {
      if (record.phase !== "completed") continue;
      if (providerId !== undefined && record.providerId !== providerId) continue;
      const key = basename(record.path);
      const result = yield* Effect.gen(function* () {
        const bucket = yield* store.open(pendingStartBucketSpec(key));
        yield* bucket.transition({
          transitions: pendingStartTransitions,
          operation: "abandon",
          state: (current) =>
            current === null ||
            current.phase !== "completed" ||
            current.attemptId !== record.attemptId ||
            !sameStartIdentity(current, record)
              ? "absent"
              : "completed",
          next: () => null,
          illegal: () =>
            new StateStoreError({
              reason: "io",
              operation: "sweepCompletedAcceleratedStarts",
              path: bucket.path,
              remediation: "Retry apps:gc --prune after the current app operation finishes.",
            }),
        });
      }).pipe(Effect.result);
      if (Result.isSuccess(result)) removed++;
      else unreadable.push(unreadableJournal(record.path, result.failure));
    }
    return { removed, unreadable };
  },
);
