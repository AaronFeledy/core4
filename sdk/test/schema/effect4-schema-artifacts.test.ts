import { describe, expect, test } from "bun:test";
import { CleanupProps, GuideProps } from "@lando/sdk/docs/components";
import { Result, Schema, SchemaIssue } from "effect";
import { deprecateField, getSchemaDeprecation } from "../../src/schema/deprecation.ts";
import { getJsonSchemaWithDeprecations } from "../../src/schema/json-schema-deprecations.ts";

describe("schema artifact generation", () => {
  test.each([
    { name: "Guide", schema: GuideProps },
    { name: "Cleanup", schema: CleanupProps },
  ])("keeps $name props limited to the published container contract", ({ schema }) => {
    const values = [{}, [], null, undefined, "text", 1, true];
    const accepted = values.map(Schema.is(schema));
    expect(accepted).toEqual([true, true, false, false, false, false, false]);
  });

  test.each([
    { name: "Guide", schema: GuideProps },
    { name: "Cleanup", schema: CleanupProps },
  ])("publishes the original $name container alternatives", ({ name, schema }) => {
    const artifact = getJsonSchemaWithDeprecations(schema);
    const definition = `${name}PropsEncoded`;
    expect(artifact).toHaveProperty("$ref", `#/$defs/${definition}`);
    expect(artifact).toHaveProperty(
      ["$defs", definition, "anyOf"],
      expect.arrayContaining([{ type: "array" }, { type: "object" }]),
    );
    expect(artifact).toHaveProperty(["$defs", definition, "anyOf", "length"], 2);
  });

  test("omits optional undefined without inventing null", () => {
    // Given an optional value that rejects explicit null.
    const schema = Schema.Struct({ value: Schema.optional(Schema.String) });
    // When projected to JSON input.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then omission remains legal and the present value is string-only.
    expect(artifact).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    });
  });

  test.each([Schema.optionalKey, Schema.optional])(
    "retains explicit null in optional nullable values (%#)",
    (optional) => {
      // Given an optional nullable property.
      const schema = Schema.Struct({ value: optional(Schema.NullOr(Schema.String)) });
      // When projected to JSON input.
      const artifact = getJsonSchemaWithDeprecations(schema);
      // Then null remains a declared alternative, not an undefined substitute.
      expect(artifact).not.toHaveProperty("required");
      expect(artifact).toHaveProperty("properties.value", { anyOf: [{ type: "string" }, { type: "null" }] });
    },
  );

  test("leaves required undefined unions and array elements outside optional-key projection", () => {
    // Given undefined outside an optional object property.
    const schema = Schema.Struct({
      value: Schema.UndefinedOr(Schema.String),
      items: Schema.Array(Schema.UndefinedOr(Schema.String)),
    });
    // When projected to JSON input.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then the pre-existing JSON codec behavior is unchanged.
    expect(artifact).toHaveProperty("required", ["value", "items"]);
    expect(artifact).toHaveProperty("properties.value.anyOf", [{ type: "string" }, { type: "null" }]);
    expect(artifact).toHaveProperty("properties.items.items.anyOf", [{ type: "string" }, { type: "null" }]);
  });

  test("emits exact optional authored keys as draft 2020-12 without nullable alternatives", () => {
    // Given an authored-input schema with an optional key.
    const schema = Schema.Struct({ port: Schema.optionalKey(Schema.Number) });
    // When emitted with the decoder's excess-property policy.
    const artifact = getJsonSchemaWithDeprecations(schema, { onExcessProperty: "error" });
    // Then the artifact agrees with absent-versus-null decoding.
    expect(artifact).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
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

  test("restores pattern constraints on string values and record keys", () => {
    // Given a pattern used on both sides of a record.
    const key = Schema.String.check(Schema.isPattern(/^x-[a-z]+$/u));
    const schema = Schema.Record(key, Schema.String.check(Schema.isPattern(/^[0-9]+$/u)));
    // When emitted as draft 2020-12.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then the key selector and value constraint both survive.
    expect(artifact).toHaveProperty("patternProperties", {
      "^x-[a-z]+$": { type: "string", pattern: "^[0-9]+$" },
    });
    expect(artifact).toHaveProperty("additionalProperties", false);
  });

  test("restores original string minimum lengths through nested filter groups", () => {
    // Given grouped string checks and an array check with the same bound.
    const grouped = Schema.isPattern(/^[a-z]+$/u).and(
      Schema.isMinLength(7, { toJsonSchema: () => ({ minLength: 7 }) }).and(Schema.isMaxLength(12)),
    );
    const schema = Schema.Struct({
      value: Schema.String.check(grouped),
      items: Schema.Array(Schema.String).check(Schema.isMinLength(7)),
    });
    // When projected to JSON input.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then string length keeps the wire contract and array cardinality is unchanged.
    expect(artifact).toHaveProperty("properties.value", {
      type: "string",
      allOf: [{ pattern: "^[a-z]+$" }, { allOf: [{ minLength: 7 }, { maxLength: 12 }] }],
    });
    expect(artifact).toHaveProperty("properties.items.minItems", 7);
  });

  test("preserves explicit check JSON Schema overrides", () => {
    // Given overrides different from the represented pattern and length.
    const schema = Schema.String.check(
      Schema.isPattern(/^original$/, { toJsonSchema: () => ({ pattern: "^override$" }) }),
      Schema.isMinLength(7, { toJsonSchema: () => ({ minLength: 2 }) }),
    );
    // When emitted.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then explicit callback output wins over representation metadata.
    expect(artifact).toMatchObject({ type: "string", pattern: "^override$", minLength: 2 });
  });

  test.each([2, 7, 8])("preserves standalone minimum length %i and base annotations", (minLength) => {
    // Given a checked string with a base annotation.
    const schema = Schema.String.check(
      Schema.isMinLength(minLength, { toJsonSchema: () => ({ minLength }) }),
    ).annotate({ title: "Token" });
    // When emitted.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then the original bound and base survive together.
    expect(artifact).toMatchObject({ type: "string", title: "Token", minLength });
  });

  test("preserves tuple minimum length overrides resembling upstream defaults", () => {
    // Given an intentional projection different from the runtime bound.
    const schema = Schema.String.check(
      Schema.isMinLength(7, { toJsonSchema: () => [{ minLength: 4 }, true] }),
    );
    // When emitted.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then the callback, not representation metadata, owns the projection.
    expect(artifact).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      minLength: 4,
    });
  });

  test("preserves intentionally empty tuple pattern projections", () => {
    // Given a runtime pattern whose author deliberately publishes no pattern.
    const schema = Schema.String.check(Schema.isPattern(/^a$/, { toJsonSchema: () => [{}, true] }));
    // When emitted.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then no constraint is inferred from the runtime representation.
    expect(artifact).toEqual({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" });
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

  test("preserves draft 2020-12 tuple keywords and local references", () => {
    // Given a named tuple used as an object field.
    const schema = Schema.Struct({
      pair: Schema.Tuple([Schema.String, Schema.Number]).annotate({ identifier: "Pair" }),
    });
    // When its document is emitted.
    const artifact = getJsonSchemaWithDeprecations(schema);
    // Then draft 2020-12 prefix items and definition pointers are used.
    expect(artifact).toHaveProperty("properties.pair.$ref", "#/$defs/Pair");
    expect(artifact).toHaveProperty("$defs.Pair.prefixItems", [{ type: "string" }, { type: "number" }]);
    expect(artifact).not.toHaveProperty("definitions");
  });
});
