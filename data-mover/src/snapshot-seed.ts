import { Effect } from "effect";

import { SnapshotOwnershipError } from "@lando/sdk/errors";
import type { SnapshotInfo, VolumeInfo, VolumeRef } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";
import { sharedVolumeInitialization } from "./volume-initialization.ts";

export const requireSnapshotSeedTarget = Effect.fn("DataMover.requireSnapshotSeedTarget")(function* (
  stateStore: StateStoreShape,
  info: SnapshotInfo,
  target: { readonly volume: VolumeInfo | undefined; readonly store: VolumeRef },
) {
  const identity = target.volume?.identity;
  const reject = () =>
    new SnapshotOwnershipError({
      message: "Physical snapshot seed target ownership or initialization claim is unverified.",
      snapshotId: info.id,
      sourceVolumeInstanceId: info.metadata?.volumeInstanceId ?? "unknown",
      ...(identity === undefined ? {} : { targetVolumeInstanceId: identity.generation }),
      remediation:
        "Seed only into a freshly created volume of the same app and service; move data between apps with db:export and db:seed <file>.",
    });
  if (identity === undefined) return yield* Effect.fail(reject());
  const initialization = yield* sharedVolumeInitialization(stateStore, identity).pipe(
    Effect.flatMap((state) => state.read),
    Effect.mapError(reject),
  );
  if (
    info.metadata === undefined ||
    info.store.app !== target.store.app ||
    info.store.store !== target.store.store ||
    identity.ownerRoot !== info.metadata.sourceRoot ||
    identity.nativeName !== target.store.store ||
    initialization?.state._tag !== "in-progress"
  ) {
    return yield* Effect.fail(reject());
  }
});
