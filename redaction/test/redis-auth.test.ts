import { expect, test } from "bun:test";
import { collectSecretEnvValues, createStandaloneRedactor } from "@lando/redaction/service";

test("redacts Redis client authentication when it arrives through the environment", () => {
  // Given
  const password = "redis-auth-secret";
  const sourceEnv = { REDISCLI_AUTH: password };
  // When
  const tokens = collectSecretEnvValues(sourceEnv);
  const redactor = createStandaloneRedactor("secrets", { sourceEnv });
  // Then
  expect(tokens).toContain(password);
  expect(redactor.redactString(password)).toBe("[redacted]");
});
