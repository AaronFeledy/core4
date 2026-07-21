import { Schema } from "effect";

// ============================================================================
// Provider host-change consent requests
// SPEC: §1.2 public contracts derive from Effect Schema.
// ============================================================================

export const ProviderHostChangeRequest = Schema.Union(
  Schema.TaggedStruct("package-install", {
    packageName: Schema.String,
    reason: Schema.String,
  }),
  Schema.TaggedStruct("enable-user-linger", {
    uid: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    reason: Schema.String,
  }),
);
export type ProviderHostChangeRequest = typeof ProviderHostChangeRequest.Type;
