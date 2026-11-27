import type { AbsolutePath } from "@lando/sdk/schema";
import { StateStore, type StateStoreShape } from "@lando/sdk/services";
import { readVolumeInitialization, volumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect, Option } from "effect";
import { volumeCoordinationKey } from "./native-volume-identity.ts";
import type { TeardownVolumeRuntime, VolumeDeletionCandidate } from "./teardown-volumes.ts";

// Receipt retirement is best effort: the volume is already gone, and a receipt left behind names
// a generation no recreated volume can carry, so a failed retirement must not undo the removal.

/** Retire the receipt of the exact generation teardown just deleted or found deleted. */
export const retireDeletedVolumeReceipt = (store: StateStoreShape, candidate: VolumeDeletionCandidate) =>
  volumeInitialization(store, {
    coordinationKey: candidate.key,
    nativeName: candidate.name,
    generation: candidate.generation,
    ownerRoot: candidate.ownerRoot,
    origin: "created",
  }).pipe(
    Effect.flatMap((initialization) => initialization.retire),
    Effect.ignore,
  );

/** Retire the receipt `ownerRoot` still holds for an app volume that is already gone. */
export const retireAbsentVolumeReceipt = Effect.fnUntraced(
  function* (runtime: TeardownVolumeRuntime, ownerRoot: AbsolutePath, nativeName: string) {
    const state = yield* Effect.serviceOption(StateStore);
    if (Option.isNone(state)) return;
    const key = yield* volumeCoordinationKey(
      { ...runtime, api: runtime, providerId: runtime.ctx.providerId },
      nativeName,
    );
    if (key === undefined) return;
    const recorded = yield* readVolumeInitialization(state.value, key);
    if (
      recorded === null ||
      recorded.identity.nativeName !== nativeName ||
      recorded.identity.ownerRoot !== ownerRoot
    )
      return;
    const initialization = yield* volumeInitialization(state.value, recorded.identity);
    yield* initialization.retire;
  },
  (effect) => Effect.ignore(effect),
);
