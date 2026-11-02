import { expect, test } from "bun:test";
import { SecretReferenceInvalidError } from "@lando/sdk/errors";
import * as references from "../src/secret-reference.ts";

test.each([
  [["services", "x", "environment", "K"], true],
  [["services", "x", "creds", "password"], true],
  [["services", "x", "creds", "rootPassword"], true],
  [["services", "x", "password"], true],
  [["tooling", "t", "env", "K"], true],
  [["tooling", "t", "cmds", 0, "env", "K"], true],
  [["toolingDefaults", "env", "K"], true],
  [["events", "e", 0, "env", "K"], true],
  [["services", "x", "environment"], false],
  [["services", "x", "environment", "K", "extra"], false],
  [["services", "x", "creds", "user"], false],
  [["services", "x", "password", "extra"], false],
  [["tooling", "t", "cmds", 0, "cmd"], false],
  [["tooling", "t", "env"], false],
  [["toolingDefaults", "env"], false],
  [["events", "e", "x", "env", "K"], false],
  [["events", "e", 0, "env"], false],
  // Preserve the existing matcher contract: only event indices are type-checked.
  [["tooling", "t", "cmds", "x", "env", "K"], true],
] as const)("eligibleBindingPath(%j) is %s", (path, expected) => {
  // Given a candidate authored path.
  // When
  const eligible = references.eligibleBindingPath(path);
  // Then
  expect(eligible).toBe(expected);
});

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
