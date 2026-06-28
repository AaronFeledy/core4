import { Effect, Stream } from "effect";

import type { DataTransferSpec } from "@lando/sdk/schema";
import type { DataMoverShape } from "@lando/sdk/services";

export interface TestDataMoverHandle {
  readonly service: DataMoverShape;
  readonly transfers: () => Effect.Effect<ReadonlyArray<DataTransferSpec>>;
  readonly streams: () => Effect.Effect<ReadonlyArray<DataTransferSpec>>;
}

export const makeTestDataMover = (): TestDataMoverHandle => {
  const transfers: DataTransferSpec[] = [];
  const streams: DataTransferSpec[] = [];

  const service: DataMoverShape = {
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
    removeSnapshot: (_id, _store?) => Effect.void,
    pruneSnapshots: () => Effect.succeed([]),
  };

  return {
    service,
    transfers: () => Effect.succeed([...transfers]),
    streams: () => Effect.succeed([...streams]),
  };
};

export const TestDataMover: TestDataMoverHandle = makeTestDataMover();
