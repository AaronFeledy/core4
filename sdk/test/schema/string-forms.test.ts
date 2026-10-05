import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  KEBAB_CASE_ID_PATTERN,
  SEMVER_CORE_PATTERN,
  SEMVER_LOOSE_PATTERN,
  SEMVER_PATTERN,
  SHA256_HEX_PATTERN,
  SHA256_PREFIXED_DIGEST_PATTERN,
  patternString,
} from "../../src/schema/string-forms.ts";

const cases = [
  {
    name: "kebab",
    pattern: KEBAB_CASE_ID_PATTERN,
    accepted: ["a", "php8", "a-0-b"],
    rejected: ["", "1a", "A", "a_1", "a--b", "a-"],
  },
  {
    name: "prefixed digest",
    pattern: SHA256_PREFIXED_DIGEST_PATTERN,
    accepted: [`sha256:${"a0".repeat(32)}`],
    rejected: [
      "a".repeat(64),
      `sha256:${"A".repeat(64)}`,
      `sha256:${"0".repeat(63)}`,
      `sha256:${"0".repeat(65)}`,
    ],
  },
  {
    name: "bare digest",
    pattern: SHA256_HEX_PATTERN,
    accepted: ["a0".repeat(32)],
    rejected: [`sha256:${"a".repeat(64)}`, "A".repeat(64), "0".repeat(63), "0".repeat(65)],
  },
  {
    name: "full semver",
    pattern: SEMVER_PATTERN,
    accepted: ["0.0.0", "1.2.3", "1.2.3-beta.1+build", "1.2.3-01"],
    rejected: ["01.0.0", "1.02.0", "1.2.03", "1.2", "v1.2.3", "1.2.3-"],
  },
  {
    name: "core semver",
    pattern: SEMVER_CORE_PATTERN,
    accepted: ["0.0.0", "1.2.3"],
    rejected: ["01.0.0", "1.02.0", "1.2.03", "1.2.3-beta.1+build", "1.2.3+build", "1.2"],
  },
  {
    name: "loose semver",
    pattern: SEMVER_LOOSE_PATTERN,
    accepted: ["01.0.0", "1.02.03", "1.2.3-beta.1", "1.2.3+build", "1.2.3-.."],
    rejected: ["1.2.3-beta.1+build", "1.2", "v1.2.3", "1.2.3-", "1.2.3_beta"],
  },
] as const;

for (const { name, pattern, accepted, rejected } of cases) {
  test.each([...accepted])(`${name} accepts %s when decoding a valid form`, (input) => {
    // Given
    const decode = Schema.decodeUnknownSync(patternString(pattern));
    // When
    const result = decode(input);
    // Then
    expect(result).toBe(input);
  });
  test.each([...rejected])(`${name} rejects %s when decoding an invalid form`, (input) => {
    // Given
    const decode = Schema.decodeUnknownResult(patternString(pattern));
    // When
    const result = decode(input);
    // Then
    expect(result._tag).toBe("Failure");
  });
}

test("uses caller projection when JSON Schema options override the pattern", () => {
  // Given
  const schema = patternString(/^x$/, { toJsonSchema: () => ({ const: "x" }) });
  // When
  const result = Schema.toJsonSchemaDocument(schema);
  // Then
  expect(result).toEqual({
    dialect: "draft-2020-12",
    definitions: {},
    schema: { type: "string", allOf: [{ const: "x" }] },
  });
});

test("uses caller diagnostics when a pattern check fails", () => {
  // Given
  const decode = Schema.decodeUnknownSync(patternString(/^x$/, { message: "Only x is accepted." }));
  // When / Then
  expect(() => decode("y")).toThrow("Only x is accepted.");
});
