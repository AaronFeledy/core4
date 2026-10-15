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

test("firstSecretReference returns the first exact or embedded ${secret:...} span", () => {
  expect(references.firstSecretReference("${secret:TOKEN}")).toBe("${secret:TOKEN}");
  expect(references.firstSecretReference("prefix-${secret:TOKEN}-suffix")).toBe("${secret:TOKEN}");
  expect(references.firstSecretReference("no secret here")).toBeUndefined();
});

test("isServiceBuildArgSecretReference matches compose object and array arg paths", () => {
  expect(references.isServiceBuildArgPath(["services", "web", "build", "args", "TOKEN"])).toBe(true);
  expect(references.isServiceBuildArgPath(["services", "web", "build", "args", 0])).toBe(true);
  expect(references.isServiceBuildArgPath(["services", "web", "environment", "TOKEN"])).toBe(false);
  expect(
    references.isServiceBuildArgSecretReference("${secret:TOKEN}", [
      "services",
      "web",
      "build",
      "args",
      "TOKEN",
    ]),
  ).toBe(true);
  expect(
    references.isServiceBuildArgSecretReference("prefix-${secret:TOKEN}", [
      "services",
      "web",
      "build",
      "args",
      0,
    ]),
  ).toBe(true);
  expect(
    references.isServiceBuildArgSecretReference("production", [
      "services",
      "web",
      "build",
      "args",
      "NODE_ENV",
    ]),
  ).toBe(false);
});
