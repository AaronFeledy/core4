import { describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";

import { SecretNotFoundError, SecretStoreUnavailableError } from "@lando/sdk/errors";
import { createSecretRedactor, parseSecretReference } from "@lando/sdk/secrets";
import type { SecretStoreShape } from "@lando/sdk/services";
import {
  ContractFailure,
  type SecretStoreContractHarness,
  makeSecretStoreContractSuite,
  runSecretStoreContractSuite,
} from "@lando/sdk/test";

const makeInMemoryStore = (id: string, secrets: Record<string, string>): SecretStoreShape => {
  const map = new Map(Object.entries(secrets));
  return {
    id,
    get: (secret) => {
      const reference = parseSecretReference(secret);
      if (Either.isLeft(reference)) return Effect.fail(reference.left);
      const value = map.get(secret);
      return value === undefined
        ? Effect.fail(new SecretNotFoundError({ message: `missing ${secret}`, secret }))
        : Effect.succeed(value);
    },
    has: (secret) => Effect.sync(() => map.has(secret)),
    list: Effect.sync(() => [...map.keys()].sort()),
  };
};

describe("SecretStore contract", () => {
  test("an in-memory store satisfies the required guarantees", async () => {
    const harness: SecretStoreContractHarness = {
      name: "in-memory",
      store: makeInMemoryStore("in-memory", { TOKEN: "s3cr3t", DB: "p@ss" }),
      known: { key: "TOKEN", value: "s3cr3t" },
      unknown: "ABSENT",
      invalidReference: "op://Vault//field",
    };
    const exit = await Effect.runPromiseExit(runSecretStoreContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("optional probes (redactor, backend-failure, cached-offline) pass when supplied", async () => {
    const harness: SecretStoreContractHarness = {
      name: "in-memory+probes",
      store: makeInMemoryStore("in-memory", { TOKEN: "s3cr3t" }),
      known: { key: "TOKEN", value: "s3cr3t" },
      unknown: "ABSENT",
      invalidReference: "op://Vault//field",
      redactor: (values) => {
        const inner = createSecretRedactor(values);
        return { redactString: (text) => inner.redact(text) };
      },
      backendFailureStore: {
        id: "offline-backend",
        get: (secret) =>
          Effect.fail(
            new SecretNotFoundError({
              message: `backend unreachable for ${secret}`,
              secret,
              remediation: "Restore connectivity to the secret backend.",
            }),
          ),
        has: () => Effect.succeed(false),
        list: Effect.succeed([]),
      },
      cachedOfflineStore: {
        store: makeInMemoryStore("cache", { TOKEN: "s3cr3t" }),
        key: "TOKEN",
        value: "s3cr3t",
      },
    };
    const exit = await Effect.runPromiseExit(runSecretStoreContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("list may include an id that equals another secret value", async () => {
    const exit = await Effect.runPromiseExit(
      runSecretStoreContractSuite({
        name: "id-equals-value",
        store: makeInMemoryStore("mem", { s3cr3t: "other" }),
        known: { key: "s3cr3t", value: "other" },
        unknown: "ABSENT",
        invalidReference: "op://Vault//field",
      }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("a store that returns the wrong value fails the contract", async () => {
    const exit = await Effect.runPromiseExit(
      runSecretStoreContractSuite({
        store: makeInMemoryStore("wrong", { TOKEN: "actual" }),
        known: { key: "TOKEN", value: "expected" },
        unknown: "ABSENT",
        invalidReference: "op://Vault//field",
      }),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("makeSecretStoreContractSuite is an alias of runSecretStoreContractSuite", () => {
    expect(makeSecretStoreContractSuite).toBe(runSecretStoreContractSuite);
  });

  test("ContractFailure is exported", () => {
    expect(ContractFailure).toBeDefined();
  });

  test("secret store contract suite rejects a store that resolves an invalid reference", async () => {
    // Given
    const store = makeInMemoryStore("permissive", { TOKEN: "value" });
    const harness = {
      store: {
        ...store,
        get: (reference: string) =>
          reference === "op://A//B" ? Effect.succeed("value") : store.get(reference),
      },
      known: { key: "TOKEN", value: "value" },
      unknown: "ABSENT",
      invalidReference: "op://A//B",
    };
    // When
    const result = await Effect.runPromise(Effect.either(runSecretStoreContractSuite(harness)));
    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ContractFailure);
  });

  test.each(["get", "has"] as const)(
    "rejects an unavailable store that hides failure in %s",
    async (method) => {
      // Given
      const failure = new SecretStoreUnavailableError({
        message: "Locked",
        storeId: "locked",
        reason: "locked",
        remediation: "Unlock the store.",
      });
      const unavailable = {
        id: "locked",
        get: () => Effect.fail(failure),
        has: () => Effect.fail(failure),
        list: Effect.succeed([]),
      };
      const store =
        method === "get"
          ? { ...unavailable, get: () => Effect.succeed("value") }
          : { ...unavailable, has: () => Effect.succeed(false) };
      // When
      const result = await Effect.runPromise(
        Effect.either(
          runSecretStoreContractSuite({
            store: makeInMemoryStore("mem", { TOKEN: "value" }),
            known: { key: "TOKEN", value: "value" },
            unknown: "ABSENT",
            invalidReference: "op://A//B",
            unavailableStore: { store, reason: "locked" },
          }),
        ),
      );
      // Then
      expect(Either.isLeft(result)).toBe(true);
    },
  );

  test.each(["locked", "unauthenticated", "denied", "timeout", "cli-missing"] as const)(
    "accepts an unavailable store preserving %s",
    async (reason) => {
      // Given
      const failure = new SecretStoreUnavailableError({
        message: "Unavailable",
        storeId: "backend",
        reason,
        remediation: "Restore the backend.",
      });
      const store: SecretStoreShape = {
        id: "backend",
        get: () => Effect.fail(failure),
        has: () => Effect.fail(failure),
        list: Effect.succeed([]),
      };
      // When
      const result = await Effect.runPromise(
        Effect.either(
          runSecretStoreContractSuite({
            store: makeInMemoryStore("mem", { TOKEN: "value" }),
            known: { key: "TOKEN", value: "value" },
            unknown: "ABSENT",
            invalidReference: "op://A//B",
            unavailableStore: { store, reason },
            backendFailureStore: store,
          }),
        ),
      );
      // Then
      expect(Either.isRight(result)).toBe(true);
    },
  );

  test("rejects an unavailable store reporting the wrong reason", async () => {
    // Given
    const failure = new SecretStoreUnavailableError({
      message: "Denied",
      storeId: "backend",
      reason: "denied",
      remediation: "Request access.",
    });
    const store: SecretStoreShape = {
      id: "backend",
      get: () => Effect.fail(failure),
      has: () => Effect.fail(failure),
      list: Effect.succeed([]),
    };
    // When
    const result = await Effect.runPromise(
      Effect.either(
        runSecretStoreContractSuite({
          store: makeInMemoryStore("mem", { TOKEN: "value" }),
          known: { key: "TOKEN", value: "value" },
          unknown: "ABSENT",
          invalidReference: "op://A//B",
          unavailableStore: { store, reason: "locked" },
        }),
      ),
    );
    // Then
    expect(Either.isLeft(result)).toBe(true);
  });
});
