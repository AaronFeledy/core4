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

export class SecretStoreUnavailableError extends Schema.TaggedError<SecretStoreUnavailableError>()(
  "SecretStoreUnavailableError",
  {
    message: Schema.String,
    storeId: Schema.String,
    reason: Schema.Literals(["locked", "unauthenticated", "denied", "timeout", "cli-missing"]),
    remediation: Schema.String,
  },
) {}

export class SecretReferenceInvalidError extends Schema.TaggedError<SecretReferenceInvalidError>()(
  "SecretReferenceInvalidError",
  {
    message: Schema.String,
    reference: Schema.String,
    remediation: Schema.String,
  },
) {}

export type SecretStoreError =
  | SecretNotFoundError
  | SecretStoreUnavailableError
  | SecretReferenceInvalidError;

/**
 * A `${secret:...}` reference appeared in service `build.args`. Classic image
 * builds send those args through `/build?buildargs`, which records them in
 * image history. Secret stores resolve environment values at start instead.
 */
export class BuildArgSecretReferenceError extends Schema.TaggedError<BuildArgSecretReferenceError>()(
  "BuildArgSecretReferenceError",
  {
    message: Schema.String,
    service: Schema.String,
    arg: Schema.String,
    remediation: Schema.String,
  },
) {}
