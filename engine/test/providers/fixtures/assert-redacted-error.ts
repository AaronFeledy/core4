import { expect } from "bun:test";
import type { ProviderError } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { canary } from "./error-registry.ts";

export const assertRedactedError = async (error: ProviderError, original: ProviderError) => {
  expect(error._tag).toBe(original._tag);
  expect(error).toBeInstanceOf(original.constructor);
  expect(error.message).toBe(original.message.replaceAll(canary, "[redacted]"));
  for (const exposed of [String(error), JSON.stringify(error), error.stack ?? ""]) {
    expect(exposed).not.toContain(canary);
    expect(exposed).toContain("[redacted]");
  }
  if ("details" in original) {
    expect("details" in error ? error.details : undefined).toEqual({
      nested: ["[redacted]", { text: "[redacted]" }],
    });
  }
  expect(error.remediation).toBe("retry [redacted]");
  const yielded = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        return yield* error;
      }),
    ),
  );
  expect(Result.isFailure(yielded) ? yielded.failure : undefined).toBe(error);
};
