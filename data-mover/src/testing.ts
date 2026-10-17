import { Effect, Stream } from "effect";

import { SnapshotNotFoundError } from "@lando/sdk/errors";
import type { DataTransferSpec } from "@lando/sdk/schema";
import { DataMover, type DataMoverShape } from "@lando/sdk/services";

export interface TestDataMoverHandle {
  readonly service: DataMoverShape;
  readonly transfers: () => Effect.Effect<ReadonlyArray<DataTransferSpec>>;
  readonly streams: () => Effect.Effect<ReadonlyArray<DataTransferSpec>>;
}

export const makeTestDataMover = (): TestDataMoverHandle => {
  const transfers: DataTransferSpec[] = [];
  const streams: DataTransferSpec[] = [];

  const service = DataMover.of({
    transfer: (spec) =>
      Effect.sync(() => {
        transfers.push(spec);
        return { accelerated: false, sizeBytes: 0 };
      }),
    transferStream: (spec) =>
      Stream.suspend(() => {
        streams.push(spec);
        return Stream.make(
          { phase: "started" as const, transferredBytes: 0 },
          { phase: "completed" as const, transferredBytes: 0 },
        );
      }),
    snapshot: (store) => Effect.succeed({ id: `test-${store.store}`, store }),
    restore: () => Effect.void,
    listSnapshots: () => Effect.succeed([]),
    resolveSnapshot: (reference, _scope) =>
      Effect.fail(
        new SnapshotNotFoundError({
          message: `Snapshot ${reference} was not found.`,
          snapshotId: reference,
          remediation:
            "Run `lando db:snapshots` to list snapshot ids and labels, then retry with one of them.",
        }),
      ),
    removeSnapshot: (_id, _store?) => Effect.void,
    pruneSnapshots: () => Effect.succeed([]),
  });

  return {
    service,
    transfers: () => Effect.succeed([...transfers]),
    streams: () => Effect.succeed([...streams]),
  };
};

export const TestDataMover: TestDataMoverHandle = makeTestDataMover();
