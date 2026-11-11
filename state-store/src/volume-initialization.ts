import { Effect, Schema, absurd } from "effect";

import {
  type VolumeIdentity,
  VolumeInitializationPhase,
  VolumeInitializationRecord,
} from "@lando/sdk/schema";
import { type StateStoreShape, type StateWrite, physicalVolumeLockKey } from "@lando/sdk/services";
import { type TransitionEdge, defineTransitions, planTransition } from "@lando/sdk/transitions";

export const VOLUME_INITIALIZATION_VERSION = 1 as const;

const edges = {
  "record-creation": {
    from: ["absent"],
    to: "fresh",
    settledIn: VolumeInitializationPhase.literals,
  },
  begin: { from: ["fresh"], to: "in-progress" },
  "finish-seeded": { from: ["in-progress"], to: "seeded" },
  "finish-failed": { from: ["in-progress"], to: "failed" },
} as const satisfies Record<string, TransitionEdge<VolumeInitializationPhase | "absent">>;

export const transitions = defineTransitions<VolumeInitializationPhase | "absent">()(edges);

export type VolumeInitializationWrite =
  | { readonly operation: "record-creation"; readonly baseline: VolumeInitializationRecord | null }
  | { readonly operation: Exclude<keyof typeof edges, "record-creation">; readonly operationId: string };

const matchesIdentity = (current: VolumeInitializationRecord | null, identity: VolumeIdentity) =>
  current !== null &&
  current.identity.coordinationKey === identity.coordinationKey &&
  current.identity.nativeName === identity.nativeName &&
  current.identity.origin === identity.origin &&
  current.identity.generation === identity.generation &&
  current.identity.ownerRoot === identity.ownerRoot;

type Write = StateWrite<VolumeInitializationRecord | null, boolean>;
const refused: Write = { _tag: "Keep", result: false };

const meetsPreconditions = (
  current: VolumeInitializationRecord | null,
  identity: VolumeIdentity,
  write: VolumeInitializationWrite,
): boolean => {
  switch (write.operation) {
    case "record-creation":
      return identity.origin === "created";
    case "begin":
      return identity.origin === "created" && write.operationId.length > 0;
    case "finish-seeded":
    case "finish-failed":
      return (
        write.operationId.length > 0 &&
        current !== null &&
        "operationId" in current.state &&
        current.state.operationId === write.operationId
      );
    default:
      return absurd(write);
  }
};

/** A record for a different generation was replaced since this claim's baseline read. */
const baselineDrifted = (
  current: VolumeInitializationRecord | null,
  identity: VolumeIdentity,
  baseline: VolumeInitializationRecord | null,
): boolean =>
  current?.identity.generation === identity.generation ||
  current?.identity.generation !== baseline?.identity.generation ||
  current?.identity.ownerRoot !== baseline?.identity.ownerRoot;

/**
 * Pure claim planner shared by the locked store and in-memory ports. A refused
 * operation keeps the record and reports `false`; a settled one reports `true`.
 */
export const planVolumeInitializationWrite = (
  current: VolumeInitializationRecord | null,
  identity: VolumeIdentity,
  write: VolumeInitializationWrite,
): Write => {
  if (!meetsPreconditions(current, identity, write)) return refused;
  if (
    write.operation === "record-creation" &&
    !matchesIdentity(current, identity) &&
    baselineDrifted(current, identity, write.baseline)
  )
    return refused;
  const phase = matchesIdentity(current, identity) ? (current?.state._tag ?? "absent") : "absent";
  const plan = planTransition(transitions, write.operation, phase, (_to): VolumeInitializationRecord => {
    switch (write.operation) {
      case "record-creation":
        return { identity, state: { _tag: "fresh" } };
      case "begin":
      case "finish-seeded":
      case "finish-failed":
        return { identity, state: { _tag: edges[write.operation].to, operationId: write.operationId } };
      default:
        return absurd(write);
    }
  });
  switch (plan._tag) {
    case "Illegal":
      return refused;
    case "Keep":
      return { _tag: "Keep", result: true };
    case "Write":
      return { _tag: "Set", value: plan.value, result: true };
  }
};

/** Only the engine's verified creation-result consumer may call recordCreation. */
export const volumeInitialization = Effect.fn("StateStore.volumeInitialization")(function* (
  store: StateStoreShape,
  identity: VolumeIdentity,
) {
  const bucket = yield* store.open({
    root: "userData",
    namespace: "volume-initialization",
    key: `${physicalVolumeLockKey(identity.coordinationKey)}.json`,
    schema: Schema.NullOr(VolumeInitializationRecord),
    version: VOLUME_INITIALIZATION_VERSION,
    lock: "advisory",
    onCorrupt: "fail",
  });
  const baseline = yield* bucket.get;
  return {
    read: bucket.get.pipe(Effect.map((current) => (matchesIdentity(current, identity) ? current : null))),
    recordCreation: bucket.mutate((current) =>
      Effect.succeed(
        planVolumeInitializationWrite(current, identity, { operation: "record-creation", baseline }),
      ),
    ),
    begin: (operationId: string) =>
      bucket.mutate((current) =>
        Effect.succeed(planVolumeInitializationWrite(current, identity, { operation: "begin", operationId })),
      ),
    finish: (input: { readonly operationId: string; readonly outcome: "seeded" | "failed" }) =>
      bucket.mutate((current) =>
        Effect.succeed(
          planVolumeInitializationWrite(current, identity, {
            operation: `finish-${input.outcome}`,
            operationId: input.operationId,
          }),
        ),
      ),
  };
});
