import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeTestSecretStore } from "@lando/core/testing";
import { createSecretRedactor } from "@lando/sdk/secrets";
import { runSecretStoreContractSuite } from "@lando/sdk/test";

import { makeEnvSecretStore } from "@lando/engine/services/secret-store";

const redactor = (values: ReadonlyArray<string>) => {
  const inner = createSecretRedactor(values);
  return { redactString: (text: string) => inner.redact(text) };
};

describe("SecretStore contract — built-in implementations", () => {
  test("TestSecretStore supports scheme references and unavailable backends", async () => {
    // Given
    const key = "op://Vault/Item/field";
    const handle = makeTestSecretStore({ schemes: ["op"], secrets: { [key]: "scheme-canary" } });
    const unavailable = makeTestSecretStore({ unavailable: "locked" });
    // When
    const value = await Effect.runPromise(handle.service.get(key));
    const failure = await Effect.runPromise(Effect.flip(unavailable.service.has("TOKEN")));
    // Then
    expect(value).toBe("scheme-canary");
    expect(failure.reason).toBe("locked");
  });
  test("the env-backed store passes the contract suite", async () => {
    const store = makeEnvSecretStore({ env: { LANDO_SECRET_TOKEN: "s3cr3t" } });
    const exit = await Effect.runPromiseExit(
      runSecretStoreContractSuite({
        name: "env",
        store,
        known: { key: "TOKEN", value: "s3cr3t" },
        unknown: "ABSENT",
        invalidReference: "bad/id",
        redactor,
      }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("TestSecretStore passes the contract suite", async () => {
    const handle = makeTestSecretStore({ secrets: { TOKEN: "s3cr3t" } });
    const exit = await Effect.runPromiseExit(
      runSecretStoreContractSuite({
        name: "test-secret-store",
        store: handle.service,
        known: { key: "TOKEN", value: "s3cr3t" },
        unknown: "ABSENT",
        invalidReference: "op://Vault/Item/field",
        redactor,
        cachedOfflineStore: { store: handle.service, key: "TOKEN", value: "s3cr3t" },
      }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });
});
