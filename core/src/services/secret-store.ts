import { type Context, Effect, Layer } from "effect";

import { SecretNotFoundError } from "@lando/sdk/errors";
import { SecretStore } from "@lando/sdk/services";

/** Default env-var prefix the built-in `SecretStore` reads `${secret:…}` ids from. */
export const DEFAULT_SECRET_ENV_PREFIX = "LANDO_SECRET_";

export interface EnvSecretStoreOptions {
  /** Env-var prefix. A `${secret:ID}` reference resolves `${prefix}${ID}`. */
  readonly prefix?: string;
  /** Environment source. Defaults to the live `process.env`. */
  readonly env?: Record<string, string | undefined>;
}

/**
 * Build the env-backed `SecretStore` implementation. `${secret:ID}` resolves the
 * env var `${prefix}${ID}` (default prefix `LANDO_SECRET_`). A missing secret
 * fails with {@link SecretNotFoundError} carrying the requested id. `list`
 * enumerates only prefixed ids (prefix stripped, sorted) so it never leaks
 * unrelated environment variables or any secret value.
 */
export const makeEnvSecretStore = (
  options: EnvSecretStoreOptions = {},
): Context.Tag.Service<typeof SecretStore> => {
  const prefix =
    options.prefix === "" || options.prefix === undefined ? DEFAULT_SECRET_ENV_PREFIX : options.prefix;
  const env = options.env ?? process.env;

  const readValue = (secret: string): string | undefined => env[`${prefix}${secret}`];

  return {
    id: "env",
    get: (secret) => {
      const value = readValue(secret);
      return value === undefined
        ? Effect.fail(
            new SecretNotFoundError({
              message: `Secret '${secret}' was not found in the environment.`,
              secret,
              remediation: `Set the environment variable ${prefix}${secret} to provide it.`,
            }),
          )
        : Effect.succeed(value);
    },
    has: (secret) => Effect.sync(() => readValue(secret) !== undefined),
    list: Effect.sync(() =>
      Object.keys(env)
        .filter((key) => key.startsWith(prefix) && env[key] !== undefined)
        .map((key) => key.slice(prefix.length))
        .sort(),
    ),
  };
};

/** Build the env-backed `SecretStore` Live Layer. */
export const makeEnvSecretStoreLive = (options: EnvSecretStoreOptions = {}): Layer.Layer<SecretStore> =>
  Layer.succeed(SecretStore, makeEnvSecretStore(options));

/** Default `SecretStore` Live Layer: env-backed, `LANDO_SECRET_` prefix, live `process.env`. */
export const SecretStoreLive: Layer.Layer<SecretStore> = makeEnvSecretStoreLive();
