import { expect, test } from "bun:test";
import { runSecretStoreContractSuite } from "@lando/sdk/test";
import { Effect } from "effect";

test("bundled 1Password store satisfies the SecretStore contract", async () => {
  // Given
  const { makeOnePasswordSecretStore } = await import("@lando/secret-store-1password");
  const known = { key: "op://Vault/Item/password", value: "contract-secret-value" };
  const store = makeOnePasswordSecretStore({
    run: (args) =>
      Effect.succeed(
        args[2] === known.key
          ? { exitCode: 0, stdout: known.value, stderr: "", timedOut: false }
          : { exitCode: 1, stdout: "", stderr: "item not found", timedOut: false },
      ),
  });
  const unavailable = makeOnePasswordSecretStore({
    run: () =>
      Effect.succeed({
        exitCode: 1,
        stdout: "",
        stderr: "not signed in",
        timedOut: false,
      }),
  });
  // When
  const result = await Effect.runPromise(
    runSecretStoreContractSuite({
      store,
      known,
      unknown: "op://Vault/Missing/password",
      invalidReference: "op://Vault//password",
      unavailableStore: { store: unavailable, reason: "unauthenticated" },
    }),
  );
  // Then
  expect(result).toBeUndefined();
});
