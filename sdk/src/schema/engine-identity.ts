import { Schema } from "effect";

// ==== Realized engine placement ====

export const EngineIdentity = Schema.Struct({
  fingerprint: Schema.NonEmptyString.annotate({
    description: "Provider-computed identity of the engine storage, independent of the connection used.",
  }),
  endpoint: Schema.NonEmptyString.annotate({
    description: "Credential-free diagnostic name of the connection used to reach the engine.",
  }),
});
export type EngineIdentity = typeof EngineIdentity.Type;
