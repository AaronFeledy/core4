import type { Effect } from "effect";

import type { StateStoreError } from "../errors/index.ts";
import type { VolumeInitializationRecord } from "../schema/volume-initialization.ts";

/** Shared host state, never a plugin-namespaced bucket. Absence or identity mismatch is unknown. */
export interface VolumeInitialization {
  readonly read: Effect.Effect<VolumeInitializationRecord | null, StateStoreError>;
  readonly begin: (operationId: string) => Effect.Effect<boolean, StateStoreError>;
  readonly finish: (input: {
    readonly operationId: string;
    readonly outcome: "seeded" | "failed";
  }) => Effect.Effect<boolean, StateStoreError>;
}
