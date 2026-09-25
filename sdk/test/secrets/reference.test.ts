import { expect, test } from "bun:test";
import { Either } from "effect";

import { SecretReferenceInvalidError } from "@lando/sdk/errors";
import * as secrets from "@lando/sdk/secrets";

test("parses a bare id to the default store", () => {
  // Given
  const raw = "DB_PASSWORD.v2-prod";
  // When
  const result = secrets.parseSecretReference(raw);
  // Then
  expect(result).toEqual(Either.right({ raw, key: raw }));
});

test("parses op://Vault/Item With Space/field?ssh-format=openssh", () => {
  // Given
  const raw = "op://Vault/Item With Space/field?ssh-format=openssh";
  // When
  const result = secrets.parseSecretReference(raw);
  // Then
  expect(result).toEqual(
    Either.right({ raw, scheme: "op", key: "Vault/Item With Space/field?ssh-format=openssh" }),
  );
});

test.each([
  "op://Vault/Item",
  "op://Vault/Item/section/field?attribute=password",
  "custom-store://A/B?attr=value",
])("accepts supported scheme path %s", (raw) => {
  // Given / When
  const result = secrets.parseSecretReference(raw);
  // Then
  expect(Either.isRight(result)).toBe(true);
});

test.each([
  "op://Vault//field",
  "op://Vault/../field",
  "op://Vault/Item/field ",
  " DB_PASS",
  "",
  "..",
  "op://Vault",
  "op://A/B/C/D/E",
  "OP://A/B",
  "1op://A/B",
  "op_foo://A/B",
  "op://A/B}",
  "op://A/B\n",
  "op://A/\tB",
  "op://A/B\u007f",
  "op://A/B\u0085",
  "op://A/B?attr=",
  "op://A/B?=value",
  "op://A/B?attr=value&other=value",
  "op://A/B?attr=value?other=value",
  "a/b",
  "op://A/%2e%2e/B",
  "op://A/B#fragment",
  "op://A/   /B",
  "op://A\n/B",
  "op\n://A/B",
  "op://A/B\n?attr=value",
])("rejects an empty segment, .. and a trailing space or other invalid grammar: %j", (raw) => {
  // Given / When
  const result = secrets.parseSecretReference(raw);
  // Then
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toBeInstanceOf(SecretReferenceInvalidError);
    expect(result.left.reference).toBe(raw);
    expect(result.left.remediation.length).toBeGreaterThan(0);
  }
});
