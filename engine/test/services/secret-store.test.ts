import { describe, expect, test } from "bun:test";
import { Cause, Effect, Either, Exit } from "effect";

import { SecretNotFoundError, SecretReferenceInvalidError } from "@lando/sdk/errors";
import { SecretStore } from "@lando/sdk/services";

import { makeEnvSecretStoreLive } from "../../src/services/secret-store";

const run = <A, E>(effect: Effect.Effect<A, E, SecretStore>, env: Record<string, string | undefined>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeEnvSecretStoreLive({ env }))));

const runExit = <A, E>(effect: Effect.Effect<A, E, SecretStore>, env: Record<string, string | undefined>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(makeEnvSecretStoreLive({ env }))));

describe("env-backed SecretStoreLive", () => {
  test("get resolves a prefixed env var to its value", async () => {
    const value = await run(
      Effect.flatMap(SecretStore, (store) => store.get("MY_TOKEN")),
      { LANDO_SECRET_MY_TOKEN: "abc123" },
    );
    expect(value).toBe("abc123");
  });

  test("get of a missing secret fails with SecretNotFoundError carrying the id", async () => {
    const exit = await runExit(
      Effect.flatMap(SecretStore, (store) => store.get("ABSENT")),
      {},
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SecretNotFoundError);
        expect(failure.value._tag).toBe("SecretNotFoundError");
        if (failure.value._tag === "SecretNotFoundError") {
          expect(failure.value.secret).toBe("ABSENT");
        }
      }
    }
  });

  test.each(["", "..", " TOKEN", "bad/id", "op://Vault/Item/field"])(
    "get rejects reference %j even when a matching env var exists",
    async (reference) => {
      // Given
      const env = { [`LANDO_SECRET_${reference}`]: "must-not-resolve" };
      // When
      const result = await run(
        Effect.flatMap(SecretStore, (store) => Effect.either(store.get(reference))),
        env,
      );
      // Then
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(SecretReferenceInvalidError);
        expect(result.left._tag).toBe("SecretReferenceInvalidError");
        if (result.left._tag === "SecretReferenceInvalidError") {
          expect(result.left.reference).toBe(reference);
        }
      }
    },
  );

  test("has reflects presence of a prefixed env var", async () => {
    const present = await run(
      Effect.flatMap(SecretStore, (store) => store.has("MY_TOKEN")),
      { LANDO_SECRET_MY_TOKEN: "x" },
    );
    const absent = await run(
      Effect.flatMap(SecretStore, (store) => store.has("MY_TOKEN")),
      {},
    );
    expect(present).toBe(true);
    expect(absent).toBe(false);
  });

  test("list returns prefix-stripped ids, sorted, excluding non-prefixed vars", async () => {
    const ids = await run(
      Effect.flatMap(SecretStore, (store) => store.list),
      {
        LANDO_SECRET_FOO: "1",
        LANDO_SECRET_BAR: "2",
        PATH: "/usr/bin",
        HOME: "/home/lando",
      },
    );
    expect(ids).toEqual(["BAR", "FOO"]);
  });

  test("list never returns secret values, only ids", async () => {
    const ids = await run(
      Effect.flatMap(SecretStore, (store) => store.list),
      { LANDO_SECRET_TOKEN: "super-secret-value" },
    );
    expect(ids).toEqual(["TOKEN"]);
    expect(ids.join(",")).not.toContain("super-secret-value");
  });

  test("supports a custom prefix", async () => {
    const value = await Effect.runPromise(
      Effect.flatMap(SecretStore, (store) => store.get("KEY")).pipe(
        Effect.provide(makeEnvSecretStoreLive({ prefix: "MYAPP_", env: { MYAPP_KEY: "v" } })),
      ),
    );
    expect(value).toBe("v");
  });

  test("empty custom prefix falls back to the default prefix", async () => {
    const env = {
      KEY: "unscoped",
      LANDO_SECRET_KEY: "scoped",
      PATH: "/usr/bin",
    };

    const value = await Effect.runPromise(
      Effect.flatMap(SecretStore, (store) => store.get("KEY")).pipe(
        Effect.provide(makeEnvSecretStoreLive({ prefix: "", env })),
      ),
    );
    const ids = await Effect.runPromise(
      Effect.flatMap(SecretStore, (store) => store.list).pipe(
        Effect.provide(makeEnvSecretStoreLive({ prefix: "", env })),
      ),
    );

    expect(value).toBe("scoped");
    expect(ids).toEqual(["KEY"]);
  });

  test("the store identifies itself as the env store", async () => {
    const id = await run(
      Effect.map(SecretStore, (store) => store.id),
      {},
    );
    expect(id).toBe("env");
  });
});
