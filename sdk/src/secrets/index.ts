/**
 * `@lando/sdk/secrets` — secret redaction primitives.
 *
 * The `SecretStore` service contract and `SecretNotFoundError` live in
 * `@lando/sdk/services` and `@lando/sdk/errors` respectively; this subpath ships
 * the single value-redactor every renderer / logger uses to keep resolved
 * secret values out of user-visible output.
 */
export * from "./redactor.ts";
export * from "./redactor-profiles.ts";
export * from "./payload-redactor.ts";
export * from "./public-default-credentials.ts";
export { isSecretEnvName, isSecretFieldName, isSecretStructuralName } from "./secret-names.ts";
export { parseSecretReference, type ParsedSecretReference } from "./reference.ts";

/** Container transport credentials recovered only for app output redaction. */
export const HOST_PROXY_CREDENTIAL_ENV_NAMES = [
  "LANDO_HOST_PROXY_TOKEN",
  "LANDO_HOST_PROXY_SESSION",
] as const;
