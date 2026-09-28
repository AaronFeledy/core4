import { dirname } from "node:path";
import { FileSystem, StateStore } from "@lando/sdk/services";
import { Effect } from "effect";
import { journalRecovery, pendingStartBucketSpec } from "./accelerated-start-record.ts";

export const acceleratedStartInventory = Effect.gen(function* () {
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
  return yield* Effect.forEach(
    keys.filter((key) => /^[a-f0-9]{64}\.json$/u.test(key)),
    (key) =>
      Effect.gen(function* () {
        const bucket = yield* store.open(pendingStartBucketSpec(key));
        const pending = yield* bucket.get;
        return pending === null || pending.phase === "completed"
          ? []
          : [{ ...pending, path: bucket.path, remediation: journalRecovery(bucket.path) }];
      }),
  ).pipe(Effect.map((entries) => entries.flat()));
});
