import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SecretNotFoundError } from "@lando/sdk/errors";
import { createSecretRedactor } from "@lando/sdk/secrets";
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
});
