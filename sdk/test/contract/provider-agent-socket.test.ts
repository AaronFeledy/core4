import { expect, test } from "bun:test";
import { Effect, Result } from "effect";

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
  const result = await Effect.runPromise(Effect.result(runProviderContract(provider)));
  // Then
  expect(Result.isSuccess(result)).toBe(true);
});

test("provider contract rejects an invalid present agentSocket capability", async () => {
  // Given: malformed plugin data at the runtime boundary.
  const provider = { ...TestRuntimeProvider, capabilities: { ...TestRuntimeProvider.capabilities } };
  Reflect.set(provider.capabilities, "agentSocket", { delivery: "invalid" });
  // When
  const result = await Effect.runPromise(Effect.result(runProviderContract(provider)));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure.assertion).toBe("capability matrix decodes");
  }
});
