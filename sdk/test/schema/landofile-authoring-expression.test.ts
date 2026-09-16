import { describe, expect, test } from "bun:test";
import * as expressions from "@lando/sdk/expressions";
import * as authoring from "@lando/sdk/schema";
import { Either, Schema } from "effect";

// ==== Authoring expression contracts through public SDK exports.
describe("authoring expression slots", () => {
  test("exposes helper names when helpers are supported or deferred", () => {
    // Given / When
    const names = expressions.EXPRESSION_HELPER_NAMES;
    // Then
    expect(names.has("default") && names.has("load") && names.has("path.join")).toBe(true);
  });

  test("retains the parsed whole expression when decoding a string site", () => {
    // Given
    const source = '{{ env.X | default("a") }}';
    const slot = authoring.authoringExpressionSlot("string");
    // When
    const result = Schema.decodeUnknownEither(slot)(source);
    // Then
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right).toMatchObject({
        _tag: "AuthoringExpression",
        form: "whole",
        expectedType: "string",
        scopes: ["env"],
        template: { whole: true },
      });
    }
  });

  test("preserves exact source when encoding a decoded expression", () => {
    // Given
    const source = '{{ env.X | default("a") }}';
    const slot = authoring.authoringExpressionSlot("string");
    const decoded = Schema.decodeUnknownSync(slot)(source);
    // When
    const encoded = Schema.encodeSync(slot)(decoded);
    // Then
    expect(encoded).toBe(source);
  });

  test.each([
    ["number", "v{{ env.V }}"],
    ["string", "{{ nope.x }}"],
    ["string", "{{ frobnicate(env.X) }}"],
    ["boolean", "{{ length(app.name) }}"],
    ["string", "plain"],
    ["string", "{{ env.X"],
    ["number", "${VAR:-x}"],
  ] as const)("rejects a %s site when its source is %s", (kind, source) => {
    // Given
    const slot = authoring.authoringExpressionSlot(kind);
    // When
    const result = Schema.decodeUnknownEither(slot)(source);
    // Then
    expect(Either.isLeft(result)).toBe(true);
  });

  test("classifies escaped interpolation as plain when parsing yields literals", () => {
    // Given
    const source = "{{{{ literal";
    // When
    const classification = authoring.classifyAuthoringSource(source);
    // Then
    expect(classification).toBe("plain");
  });

  test("excludes expressions when checking plain authoring strings", () => {
    // Given
    const source = "{{ env.X }}";
    // When
    const plain = authoring.isPlainAuthoringString(source);
    // Then
    expect(plain).toBe(false);
  });

  test("treats and/or operand agreement like default rather than as boolean", () => {
    // Given
    const stringSlot = authoring.authoringExpressionSlot("string");
    const booleanSlot = authoring.authoringExpressionSlot("boolean");
    // When / Then
    expect(Either.isRight(Schema.decodeUnknownEither(stringSlot)('{{ and(true, "x") }}'))).toBe(true);
    expect(Either.isRight(Schema.decodeUnknownEither(booleanSlot)("{{ and(true, true) }}"))).toBe(true);
    expect(Either.isLeft(Schema.decodeUnknownEither(stringSlot)("{{ not(false) }}"))).toBe(true);
  });

  test("does not classify regexMatch as a boolean helper", () => {
    // Given
    const stringSlot = authoring.authoringExpressionSlot("string");
    // When
    const result = Schema.decodeUnknownEither(stringSlot)('{{ regexMatch("abc", "a") }}');
    // Then
    expect(Either.isRight(result)).toBe(true);
  });
  test("accepts a composite when shell parameter syntax occupies a string site", () => {
    // Given
    const slot = authoring.authoringExpressionSlot("string");
    // When
    const result = Schema.decodeUnknownEither(slot)("${VAR:-x}");
    // Then
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right).toMatchObject({ form: "composite", scopes: ["env"] });
    }
  });
});
