import { Struct } from "effect";
import { Schema } from "effect";

import { VolumeIdentity } from "./volume-identity.ts";

// ==== Generation-bound initialization evidence ====
export const VolumeCreationFact = Schema.Struct(
  Struct.pick(VolumeIdentity.fields, ["nativeName", "generation", "ownerRoot"]),
);
export type VolumeCreationFact = typeof VolumeCreationFact.Type;

export const VolumeInitializationPhase = Schema.Literals(["fresh", "in-progress", "seeded", "failed"]);
export type VolumeInitializationPhase = typeof VolumeInitializationPhase.Type;

export const VolumeInitializationRecord = Schema.Struct({
  identity: VolumeIdentity.annotate({
    description: "Physical generation and canonical owner of this record.",
  }),
  state: Schema.Union([
    Schema.Struct({ _tag: VolumeInitializationPhase.members[0] }),
    Schema.Struct({
      _tag: VolumeInitializationPhase.pick(["in-progress", "seeded", "failed"]),
      operationId: Schema.NonEmptyString.annotate({
        description: "Operation that claimed this generation.",
      }),
    }),
  ]).annotate({
    description: "Creation evidence or the durable outcome of its single initialization claim.",
  }),
});
export type VolumeInitializationRecord = typeof VolumeInitializationRecord.Type;
