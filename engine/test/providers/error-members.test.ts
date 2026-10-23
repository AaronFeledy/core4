import { afterEach, expect, test } from "bun:test";
import { registerRedactionValues, resetRegisteredRedactionValuesForTesting } from "@lando/redaction/service";
import { ProviderUnavailableError, ServiceStartError } from "@lando/sdk/errors";
import { type ProviderError, RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { Effect, Result, Schema, type Scope } from "effect";
import { providerMemberPolicy } from "../../src/providers/output-policy.ts";
import { assertRedactedError } from "./fixtures/assert-redacted-error.ts";
import { canary, plan, registryLayer } from "./fixtures/error-registry.ts";
import { availabilityError, failingProvider, memberError } from "./fixtures/failing-provider.ts";
import { memberCalls } from "./fixtures/member-calls.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

const calls: Readonly<
  Record<
    string,
    ((provider: RuntimeProviderShape) => Effect.Effect<unknown, ProviderError, Scope.Scope>) | undefined
  >
> = memberCalls;
test.each(Object.entries(providerMemberPolicy).filter(([, [, errors]]) => errors !== "none"))(
  "%s returns a redacted, canonical, yieldable provider error",
  async (member, [outputPolicy]) => {
    // Given
    const candidate = failingProvider();
    const output = outputPolicy === "app-output" || outputPolicy === "owner-output";
    const provider = output ? { ...candidate, readAppEnvironment: () => Effect.succeed([]) } : candidate;
    const invoke = calls[member];
    if (invoke === undefined) throw new Error(`Missing invocation for ${member}`);
    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const selected = yield* (yield* RuntimeProviderRegistry).select(plan);
          yield* registerRedactionValues([canary]);
          return yield* Effect.result(invoke(selected));
        }),
      ).pipe(Effect.provide(registryLayer(provider))),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error(`Expected ${member} to fail`);
    const original = member === "isAvailable" ? availabilityError : memberError;
    await assertRedactedError(result.failure, original);
    const encoded =
      member === "isAvailable"
        ? Schema.encodeUnknownSync(ProviderUnavailableError)(result.failure)
        : Schema.encodeUnknownSync(ServiceStartError)(result.failure);
    expect(JSON.stringify(encoded)).not.toContain(canary);
    expect(JSON.stringify(encoded)).toContain("[redacted]");
  },
);
