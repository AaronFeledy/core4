import { Schema } from "effect";

/**
 * Single tagged error for every `StateStore` / `StateBucket` operation. The
 * `reason` discriminator distinguishes filesystem IO failures, decode/codec
 * failures, advisory-lock contention, path-containment escapes, older envelope
 * versions that could not be migrated (`version`), and envelopes stamped with a
 * version newer than this Lando supports (`newer-version`). `operation` names
 * the bucket method that failed; `path`, `cause`, `remediation`, and the
 * stored/supported envelope versions carry diagnostics.
 */
export class StateStoreError extends Schema.TaggedError<StateStoreError>()("StateStoreError", {
  reason: Schema.Literals(["io", "decode", "lock", "path", "version", "newer-version"]),
  operation: Schema.String,
  path: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  lockFailure: Schema.optional(Schema.Literals(["timeout", "refused"])),
  resource: Schema.optional(Schema.String),
  ownerPid: Schema.optional(Schema.Int),
  heldMs: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Int),
  storedVersion: Schema.optional(Schema.Int),
  supportedVersion: Schema.optional(Schema.Int),
  cause: Schema.optional(Schema.Unknown),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {
  override readonly message = `State store ${this.operation} failed (${this.reason}).`;
}
