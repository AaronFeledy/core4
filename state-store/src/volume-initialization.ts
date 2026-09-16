import { Effect, Schema } from "effect";

import type { VolumeIdentity } from "@lando/sdk/schema";
import { VolumeInitializationRecord } from "@lando/sdk/schema";
import { type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";

/** Only the engine's verified creation-result consumer may call recordCreation. */
export const volumeInitialization = (store: StateStoreShape, identity: VolumeIdentity) =>
  Effect.gen(function* () {
    const bucket = yield* store.open({
      root: "userData",
      namespace: "volume-initialization",
      key: `${physicalVolumeLockKey(identity.coordinationKey)}.json`,
      schema: Schema.NullOr(VolumeInitializationRecord),
      version: 1,
      lock: "advisory",
      onCorrupt: "fail",
    });
    const baseline = yield* bucket.get;
    const matches = (current: VolumeInitializationRecord | null) =>
      current !== null &&
      current.identity.coordinationKey === identity.coordinationKey &&
      current.identity.nativeName === identity.nativeName &&
      current.identity.origin === identity.origin &&
      current.identity.generation === identity.generation &&
      current.identity.ownerRoot === identity.ownerRoot;
    return {
      read: bucket.get.pipe(Effect.map((current) => (matches(current) ? current : null))),
      recordCreation: bucket.modify((current) => {
        if (identity.origin !== "created") return [false, current] as const;
        if (matches(current)) return [true, current] as const;
        if (current?.identity.generation === identity.generation) return [false, current] as const;
        if (
          current?.identity.generation !== baseline?.identity.generation ||
          current?.identity.ownerRoot !== baseline?.identity.ownerRoot
        )
          return [false, current] as const;
        return [true, { identity, state: { _tag: "fresh" } }] as const;
      }),
      begin: (operationId: string) =>
        bucket.modify((current) =>
          identity.origin === "created" &&
          matches(current) &&
          current?.state._tag === "fresh" &&
          operationId.length > 0
            ? ([true, { identity, state: { _tag: "in-progress", operationId } }] as const)
            : ([false, current] as const),
        ),
      finish: (input: { readonly operationId: string; readonly outcome: "seeded" | "failed" }) =>
        bucket.modify((current) =>
          matches(current) &&
          current?.state._tag === "in-progress" &&
          current.state.operationId === input.operationId
            ? ([true, { identity, state: { _tag: input.outcome, operationId: input.operationId } }] as const)
            : ([false, current] as const),
        ),
    };
  });
