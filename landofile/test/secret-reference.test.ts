import { expect, test } from "bun:test";
import { SecretReferenceInvalidError } from "@lando/sdk/errors";
import * as references from "../src/secret-reference.ts";

test("exactSecretReference returns SecretReferenceInvalidError for a malformed scheme ref", () => {
  // Given / When
  const result = references.exactSecretReference("${secret:op://Vault//field}");
  // Then
  expect(result).toBeInstanceOf(SecretReferenceInvalidError);
});

test("exactSecretReference preserves scheme paths with spaces and ignores embedded references", () => {
  // Given / When / Then
  expect(references.exactSecretReference("${secret:op://Vault/Item Name/field}")).toEqual({
    raw: "op://Vault/Item Name/field",
    scheme: "op",
    key: "Vault/Item Name/field",
  });
  expect(references.exactSecretReference("prefix-${secret:TOKEN}")).toBeUndefined();
});
