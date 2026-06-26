import { Schema } from "effect";

/**
 * Single tagged error for every `StateStore` / `StateBucket` operation. The
 * `reason` discriminator distinguishes filesystem IO failures, decode/codec
 * failures, advisory-lock contention, path-containment escapes, and version
 * envelope mismatches. `operation` names the bucket method that failed; `path`,
 * `cause`, and `remediation` carry optional diagnostics.
 */
export class StateStoreError extends Schema.TaggedError<StateStoreError>()("StateStoreError", {
  reason: Schema.Literal("io", "decode", "lock", "path", "version"),
  operation: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
  remediation: Schema.optional(Schema.String),
}) {}
