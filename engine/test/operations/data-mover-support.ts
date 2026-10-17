import { DataMover } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";

export const emptySnapshotsLayer = Layer.succeed(
  DataMover,
  DataMover.of({
    transfer: () => Effect.die("transfer is not used by teardown"),
    transferStream: () => Stream.die("transferStream is not used by teardown"),
    snapshot: () => Effect.die("snapshot is not used by teardown"),
    restore: () => Effect.die("restore is not used by teardown"),
    listSnapshots: () => Effect.succeed([]),
    removeSnapshot: () => Effect.die("no snapshots to remove"),
    pruneSnapshots: () => Effect.die("pruneSnapshots is not used by teardown"),
  }),
);
