import { Schema } from "effect";

export const RecordedMachineOwnership = Schema.Union([
  Schema.Struct({
    name: Schema.Literal("lando"),
    createdByLando: Schema.Literal(false),
    createdAt: Schema.optionalKey(Schema.Never),
  }),
  // Without `createdAt` the record cannot identify the machine generation, so setup
  // never trusts it and uninstall reports the machine as ambiguous.
  Schema.Struct({
    name: Schema.Literal("lando"),
    createdByLando: Schema.Literal(true),
    createdAt: Schema.optionalKey(Schema.NonEmptyString),
  }),
]);
export type RecordedMachineOwnership = typeof RecordedMachineOwnership.Type;

export const SetupMachineOwnership = Schema.Struct({ machine: RecordedMachineOwnership });
