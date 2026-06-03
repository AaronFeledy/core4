import { Schema } from "effect";

/**
 * Raised when a `${secret:…}` reference (or a `SecretStore.get` call) cannot be
 * resolved by the active `SecretStore`. Carries the requested secret id so the
 * renderer can point the user at the missing source.
 */
export class SecretNotFoundError extends Schema.TaggedError<SecretNotFoundError>()("SecretNotFoundError", {
  message: Schema.String,
  secret: Schema.String,
  remediation: Schema.optional(Schema.String),
}) {}
