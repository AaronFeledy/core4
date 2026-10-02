import { expect, test } from "bun:test";
import { Effect, Either } from "effect";

import { TestRuntimeProvider, runProviderContract } from "@lando/sdk/test";

test("provider contract accepts a present agentSocket capability", async () => {
  // Given
  const provider = {
    ...TestRuntimeProvider,
    capabilities: {
      ...TestRuntimeProvider.capabilities,
      agentSocket: { delivery: "bind-directory" as const },
    },
  };
  // When
  const result = await Effect.runPromise(Effect.either(runProviderContract(provider)));
  // Then
  expect(Either.isRight(result)).toBe(true);
});

test("provider contract rejects an invalid present agentSocket capability", async () => {
  // Given: malformed plugin data at the runtime boundary.
  const provider = { ...TestRuntimeProvider, capabilities: { ...TestRuntimeProvider.capabilities } };
  Reflect.set(provider.capabilities, "agentSocket", { delivery: "invalid" });
  // When
  const result = await Effect.runPromise(Effect.either(runProviderContract(provider)));
  // Then
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left.assertion).toBe("capability matrix decodes");
  }
});
