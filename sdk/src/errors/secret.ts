import { Effect, Schema } from "effect";

/**
 * Raised when a `${secret:…}` reference (or a `SecretStore.get` call) cannot be
 * resolved by the active `SecretStore`. Carries the requested secret id so the
 * renderer can point the user at the missing source.
 */
export class SecretNotFoundError extends Schema.TaggedError<SecretNotFoundError>()("SecretNotFoundError", {
  message: Schema.String,
  secret: Schema.String,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).pipe(
    Schema.withConstructorDefault(
      Effect.succeed("Create the named secret in the active secret store, then retry."),
    ),
  ),
}) {}

export class SecretStoreUnavailableError extends Schema.TaggedError<SecretStoreUnavailableError>()(
  "SecretStoreUnavailableError",
  {
    message: Schema.String,
    storeId: Schema.String,
    reason: Schema.Literals(["locked", "unauthenticated", "denied", "timeout", "cli-missing"]),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export class SecretReferenceInvalidError extends Schema.TaggedError<SecretReferenceInvalidError>()(
  "SecretReferenceInvalidError",
  {
    message: Schema.String,
    reference: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export type SecretStoreError =
  | SecretNotFoundError
  | SecretStoreUnavailableError
  | SecretReferenceInvalidError;
