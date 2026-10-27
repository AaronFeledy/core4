import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result } from "effect";
import { plan, registryLayer } from "./fixtures/error-registry.ts";

test("provider registry masks environment values that were never registered", async () => {
  // Given: a provider failure containing an unlabelled environment secret.
  const secret = "registry-environment-canary";
  const previous = process.env.P5_REGISTRY_SECRET;
  process.env.P5_REGISTRY_SECRET = secret;
  const original = new ProviderUnavailableError({
    providerId: plan.provider,
    operation: "make",
    message: `failed ${secret}`,
    remediation: `repair ${secret}`,
    details: { output: secret },
  });
  try {
    // When: the registry constructs a provider without explicit value registration.
    const result = await Effect.runPromise(
      Effect.flatMap(RuntimeProviderRegistry, (registry) => Effect.result(registry.select(plan))).pipe(
        Effect.provide(
          registryLayer(TestRuntimeProvider, { contribution: { make: () => Effect.fail(original) } }),
        ),
      ),
    );
    // Then: the typed failure's display fields contain no secret bytes.
    if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
      throw new Error("Expected provider failure");
    expect(result.failure).toMatchObject({ message: "failed [redacted]", remediation: "repair [redacted]" });
    expect(JSON.stringify(result.failure.details)).not.toContain(secret);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "P5_REGISTRY_SECRET");
    else process.env.P5_REGISTRY_SECRET = previous;
  }
});
