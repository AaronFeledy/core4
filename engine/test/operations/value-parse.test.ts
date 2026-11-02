import { expect, test } from "bun:test";
import { Result } from "effect";
import { parseTypedValue } from "../../src/config-write/value-parse";

test.each([
  ["~", "~"],
  ['"line\\nnext"', "line\nnext"],
  ["'it''s text'", "it's text"],
  ["null", null],
  ["false", false],
])("uses file scalar semantics for %s", (raw, expected) => {
  // Given: CLI YAML scalar text.
  // When
  const result = parseTypedValue(raw, "yaml");
  // Then
  expect(result).toEqual(Result.succeed(expected));
});

test("rejects non-finite decimal YAML numbers", () => {
  // Given
  const raw = "9".repeat(400);
  // When
  const result = parseTypedValue(raw, "yaml");
  // Then
  expect(Result.isFailure(result)).toBe(true);
});
