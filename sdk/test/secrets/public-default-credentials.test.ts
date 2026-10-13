import { expect, test } from "bun:test";
import * as sdkSecrets from "@lando/sdk/secrets";
import {
  DEFAULT_PASSWORD,
  MINIO_DEFAULT_PASSWORD,
  PUBLIC_DEFAULT_CREDENTIALS,
  isPublicDefaultCredential,
} from "@lando/sdk/secrets";
import surface from "../fixtures/sdk-mvp-surface.json";

test("keeps the published default credential exports available on the public secrets subpath", () => {
  // Given
  const expected = surface.publicDefaultCredentialExports;
  // When
  const names = Object.keys(sdkSecrets);
  // Then
  for (const name of expected) expect(names).toContain(name);
});

test("publishes an immutable list of unchanged default credential values", () => {
  // Given
  const passwords = [DEFAULT_PASSWORD, MINIO_DEFAULT_PASSWORD];
  // When
  const values = [...PUBLIC_DEFAULT_CREDENTIALS];
  // Then
  expect(passwords).toEqual(["lando", "landolando"]);
  expect(values).toEqual(passwords);
  expect(Object.isFrozen(PUBLIC_DEFAULT_CREDENTIALS)).toBe(true);
});

test.each([
  ["lando", true],
  ["landolando", true],
  ["LANDO", false],
  [" lando ", false],
  ["lando-custom", false],
  ["mylando", false],
  ["private-password", false],
] as const)("recognizes %s as a published default only on an exact match", (value, expected) => {
  // Given: an original credential value.
  // When
  const matches = isPublicDefaultCredential(value);
  // Then
  expect(matches).toBe(expected);
});
