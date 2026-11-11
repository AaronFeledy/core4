import type { VolumeIdentity } from "@lando/sdk/schema";
import type { StateStoreShape, VolumeInitialization } from "@lando/sdk/services";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect } from "effect";

export const sharedVolumeInitialization = (store: StateStoreShape, identity: VolumeIdentity) =>
  volumeInitialization(store, identity).pipe(
    Effect.map(({ read, begin, finish }): VolumeInitialization => ({ read, begin, finish })),
  );
