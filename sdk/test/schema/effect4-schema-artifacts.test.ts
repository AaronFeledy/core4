import { describe, expect, test } from "bun:test";
import { Result, Schema, SchemaIssue } from "effect";
import { deprecateField, getSchemaDeprecation } from "../../src/schema/deprecation.ts";
import { getJsonSchemaWithDeprecations } from "../../src/schema/json-schema-deprecations.ts";

describe("schema artifact generation", () => {
  test("emits exact optional authored keys as draft-07 without nullable alternatives", () => {
    // Given an authored-input schema with an optional key.
    const schema = Schema.Struct({ port: Schema.optionalKey(Schema.Number) });
    // When emitted with the decoder's excess-property policy.
    const artifact = getJsonSchemaWithDeprecations(schema, { onExcessProperty: "error" });
    // Then the artifact agrees with absent-versus-null decoding.
    expect(artifact).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { port: { type: "number" } },
      additionalProperties: false,
    });
    expect(Result.isSuccess(Schema.decodeUnknownResult(schema)({}))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(schema)({ port: null }))).toBe(true);
  });

  test("preserves custom check messages in path-qualified decode failures", () => {
    // Given a nested custom check.
    const schema = Schema.Struct({
      config: Schema.Struct({
        port: Schema.Number.check(Schema.isGreaterThan(0, { message: "Port must be positive." })),
      }),
    });
    // When decoding an invalid authored value.
    const result = Schema.decodeUnknownResult(schema)({ config: { port: 0 } });
    // Then SchemaIssue retains the exact custom text and its full path.
    if (Result.isSuccess(result)) throw new Error("Expected a decode failure");
    const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
    expect(issues.map((issue) => `${issue.path?.join(".")}: ${issue.message}`)).toEqual([
      "config.port: Port must be positive.",
    ]);
  });

  test("keeps numeric constraints without adding non-finite string alternatives", () => {
    // Given a constrained numeric input.
    const schema = Schema.Struct({ port: Schema.Number.check(Schema.isGreaterThan(0)) });
    // When emitted through the JSON-input projection.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then the numeric bound survives and accepted values remain numeric.
    expect(artifact).toHaveProperty("properties.port", { type: "number", exclusiveMinimum: 0 });
  });

  test("preserves field deprecation annotations through checks and draft conversion", () => {
    // Given a deprecated checked field.
    const notice = { since: "4.1.0", severity: "warn", note: "Use the replacement." } as const;
    const field = deprecateField(Schema.String.check(Schema.isMinLength(1)), notice);
    const schema = Schema.Struct({ old: field });
    // When the field is emitted.
    const artifact = getJsonSchemaWithDeprecations(schema, { onExcessProperty: "error" });
    // Then metadata remains attached to the property, not an unrelated definition.
    expect(getSchemaDeprecation(field.ast)).toEqual(notice);
    expect(artifact).toHaveProperty("properties.old.x-deprecation", notice);
  });

  test("converts tuple keywords and local references to draft-07", () => {
    // Given a named tuple used as an object field.
    const schema = Schema.Struct({
      pair: Schema.Tuple([Schema.String, Schema.Number]).annotate({ identifier: "Pair" }),
    });
    // When its document is emitted.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then draft-07 items and definition pointers are used.
    expect(artifact).toHaveProperty("properties.pair.$ref", "#/definitions/Pair");
    expect(artifact).toHaveProperty("definitions.Pair.items", [{ type: "string" }, { type: "number" }]);
    expect(artifact).not.toHaveProperty("definitions.Pair.prefixItems");
  });
});
