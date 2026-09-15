import { Schema } from "effect";

import { VolumeIdentity } from "./volume-identity.ts";

// ==== Generation-bound initialization evidence ====
export const VolumeCreationFact = VolumeIdentity.pick("nativeName", "generation", "ownerRoot");
export type VolumeCreationFact = typeof VolumeCreationFact.Type;

export const VolumeInitializationRecord = Schema.Struct({
  identity: VolumeIdentity.annotations({
    description: "Physical generation and canonical owner of this record.",
  }),
  state: Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("fresh") }),
    Schema.Struct({
      _tag: Schema.Literal("in-progress", "seeded", "failed"),
      operationId: Schema.NonEmptyString.annotations({
        description: "Operation that claimed this generation.",
      }),
    }),
  ).annotations({
    description: "Creation evidence or the durable outcome of its single initialization claim.",
  }),
});
export type VolumeInitializationRecord = typeof VolumeInitializationRecord.Type;
