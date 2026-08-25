import { expect, test } from "bun:test";

import {
  CommandRegistrationError,
  EmptyResultSchema,
  validateCommandSpec,
} from "../../src/cli/spec/command-base.ts";

test("throws CommandRegistrationError when helpGroup is not common", () => {
  // Given
  const spec = { id: "app:example", resultSchema: EmptyResultSchema, helpGroup: "nope" };

  // When / Then
  expect(() => validateCommandSpec(spec)).toThrow(CommandRegistrationError);
});

test("accepts helpGroup common", () => {
  // Given
  const spec = { id: "app:example", resultSchema: EmptyResultSchema, helpGroup: "common" as const };

  // When / Then
  expect(() => validateCommandSpec(spec)).not.toThrow();
});
