import { expect, test } from "bun:test";
import type { EnvironmentValue } from "@lando/sdk/schema";
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

test.each([
  { _tag: "SecretRef", reference: "REDIS_PASSWORD" },
  { _tag: "BoundText", parts: ["prefix-", { reference: "REDIS_PASSWORD", encoding: "raw" }] },
] satisfies readonly EnvironmentValue[])("ignores unresolved Redis password %j", (password) => {
  // Given
  const envPassword = "literal-environment-secret";
  // When
  const tokens = collectLandofileRedactionTokens({
    services: { cache: { password, environment: { PASSWORD: envPassword } } },
  });
  // Then
  expect(tokens).toEqual([envPassword]);
});
