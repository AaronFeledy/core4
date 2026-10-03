import { describe, expect, test } from "bun:test";
import { getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import { Schema } from "effect";
import { EmptyResultSchema } from "../../src/cli/spec/command-spec.ts";

describe("empty command result wire contract", () => {
  test.each([{}, { value: 1 }, [], [null, "value"]].map((value) => ({ value })))(
    "accepts object and array payloads (%#)",
    ({ value }) => {
      // Given a JSON container accepted by the published result contract.
      // When validating the command's result schema.
      const accepted = Schema.is(EmptyResultSchema)(value);
      // Then the existing wire value remains accepted.
      expect(accepted).toBe(true);
    },
  );

  test.each([null, undefined, "", "value", 0, 1, false, true])(
    "rejects non-container payloads (%#)",
    (value) => {
      // Given a value outside the published object-or-array contract.
      // When validating the command's result schema.
      const accepted = Schema.is(EmptyResultSchema)(value);
      // Then Effect 4's broader empty-struct semantics do not widen this result.
      expect(accepted).toBe(false);
    },
  );

  test("emits the existing draft-07 object-or-array contract", () => {
    // Given the result schema shared by commands without a payload.
    // When generating its public artifact.
    const artifact = getJsonSchemaWithDeprecations(EmptyResultSchema);
    // Then both branches and their unrestricted contents remain unchanged.
    expect(artifact).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      anyOf: expect.arrayContaining([{ type: "object" }, { type: "array" }]),
    });
    expect(artifact).toHaveProperty("anyOf.length", 2);
  });

  test("does not disguise a genuinely broader empty struct as an object-only schema", () => {
    // Given Effect 4's intentional non-null empty-struct contract.
    const schema = Schema.Struct({});
    // When emitted through the same artifact path.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then the wider shape is preserved rather than globally rewritten.
    expect(Schema.is(schema)("scalar")).toBe(true);
    expect(artifact).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      not: { type: "null" },
    });
  });
});
