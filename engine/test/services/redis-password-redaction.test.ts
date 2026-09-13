import { expect, test } from "bun:test";
import { collectLandofileRedactionTokens } from "../../src/services/app-plan-redaction.ts";

test("collects an authored Redis password before service resolution", () => {
  // Given
  const password = "authored-redis-secret";
  // When
  const tokens = collectLandofileRedactionTokens({ services: { cache: { password } } });
  // Then
  expect(tokens).toContain(password);
});

test("collects an authored Redis password without dropping environment secrets", () => {
  // Given
  const password = "authored-redis-secret";
  const envPassword = "env-password-secret";
  // When
  const tokens = collectLandofileRedactionTokens({
    services: { cache: { password, environment: { password: envPassword } } },
  });
  // Then
  expect(tokens).toContain(password);
  expect(tokens).toContain(envPassword);
});
