import { Effect } from "effect";

import { type AbsolutePath, type SnapshotInfo, appIdentityKey, snapshotHandle } from "@lando/sdk/schema";
import { DataMover } from "@lando/sdk/services";

export const ownedSnapshots = Effect.fn("AppOperation.ownedSnapshots")(function* (
  roots: ReadonlyArray<AbsolutePath>,
) {
  const mover = yield* DataMover;
  const owned = new Map<string, SnapshotInfo>();
  for (const root of roots) {
    for (const info of yield* mover.listSnapshots({ ownerKey: appIdentityKey("owner", root) })) {
      owned.set(`${info.owner.ownerKey}\0${info.id}`, info);
    }
  }
  return [...owned.values()];
});

export const removeSnapshots = Effect.fn("AppOperation.removeSnapshots")(function* (
  infos: ReadonlyArray<SnapshotInfo>,
) {
  const mover = yield* DataMover;
  let removed = 0;
  for (const info of infos) {
    const outcome = yield* mover.removeSnapshot(snapshotHandle(info)).pipe(
      Effect.as("removed" as const),
      // Another destroy or prune removed it after listing; it is gone, but not by this purge.
      Effect.catchTag("SnapshotNotFoundError", () => Effect.succeed("absent" as const)),
    );
    if (outcome === "removed") removed += 1;
  }
  return removed;
});
