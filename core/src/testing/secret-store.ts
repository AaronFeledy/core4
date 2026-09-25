// In-memory `SecretStore` test double. Mirrors the env-backed `SecretStoreLive`
// contract (`get`/`has`/`list`, `SecretNotFoundError` on a missing id) against a
// `Map` of secret ids to values so `runSecretStoreContractSuite` can run without
// reading `process.env` or any external backend.

import { Effect, Either, Layer } from "effect";

import { SecretNotFoundError, SecretReferenceInvalidError } from "@lando/sdk/errors";
import { parseSecretReference } from "@lando/sdk/secrets";
import { SecretStore, type SecretStoreShape } from "@lando/sdk/services";

/** Options for {@link makeTestSecretStore}. */
export interface TestSecretStoreOptions {
  /** Stable store id. Defaults to `"test"`. */
  readonly id?: string;
  /** Seed secret ids to values. */
  readonly secrets?: Record<string, string>;
}

/** Handle returned by {@link makeTestSecretStore}. */
export interface TestSecretStore {
  /** The `SecretStore` implementation. */
  readonly service: SecretStoreShape;
  /** A `Layer` providing the in-memory store. */
  readonly layer: Layer.Layer<SecretStore>;
  /** Seed (or overwrite) a secret id's value. */
  readonly seed: (secret: string, value: string) => void;
  /** Remove a secret id (so `get` fails again). */
  readonly forget: (secret: string) => void;
  /** Snapshot the backing map. */
  readonly snapshot: () => ReadonlyMap<string, string>;
}

/**
 * Build an in-memory `SecretStore` double. `get(id)` resolves a seeded value and
 * fails with {@link SecretNotFoundError} (carrying the requested id) when absent;
 * `has` and `list` are total, and `list` returns seeded ids sorted without ever
 * leaking values.
 */
export const makeTestSecretStore = (options: TestSecretStoreOptions = {}): TestSecretStore => {
  const secrets = new Map<string, string>(Object.entries(options.secrets ?? {}));
  const id = options.id ?? "test";

  const service: SecretStoreShape = {
    id,
    get: (secret) => {
      const reference = parseSecretReference(secret);
      if (Either.isLeft(reference)) return Effect.fail(reference.left);
      if (reference.right.scheme !== undefined) {
        return Effect.fail(
          new SecretReferenceInvalidError({
            message: "The test secret store only accepts bare secret ids.",
            reference: secret,
            remediation: "Use a bare secret id or route this reference to its scheme's secret store.",
          }),
        );
      }
      const value = secrets.get(secret);
      return value === undefined
        ? Effect.fail(
            new SecretNotFoundError({
              message: `Secret '${secret}' was not found in the test secret store.`,
              secret,
              remediation: `Seed it via makeTestSecretStore({ secrets: { ${secret}: "…" } }).`,
            }),
          )
        : Effect.succeed(value);
    },
    has: (secret) => Effect.sync(() => secrets.has(secret)),
    list: Effect.sync(() => [...secrets.keys()].sort()),
  };

  return {
    service,
    layer: Layer.succeed(SecretStore, service),
    seed: (secret, value) => {
      secrets.set(secret, value);
    },
    forget: (secret) => {
      secrets.delete(secret);
    },
    snapshot: () => new Map(secrets),
  };
};

/** Convenience singleton seeded empty; mirrors `TestRemoteSource`/`TestTunnelService`. */
export const TestSecretStore: TestSecretStore = makeTestSecretStore();
