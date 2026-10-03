import { describe, expect, test } from "bun:test";
import * as schema from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { type Effect, Result, Schema } from "effect";

// ==== Static service contract
type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type TranslateRequiresNothing = Assert<
  Equal<Effect.Services<ReturnType<ConfigTranslatorShape["translate"]>>, never>
>;

// ==== Snapshot wire contracts
describe("config translation schemas", () => {
  test("retains the base string projection when publishing document bytes", () => {
    // Given the historical wire contract without format assertions.
    // When the owning bytes field is projected.
    const projected = schema.getJsonSchema("ConfigTranslateDocumentBytes");
    // Then publication preserves the wire contract and field description.
    expect(projected).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "string",
      description: "Bounded raw source bytes, encoded as base64 on the wire.",
    });
  });

  test.each(["!invalid!", "A", 42, null])("rejects invalid byte input %j", (input) => {
    // Given an input outside the existing base64 decoder contract.
    // When decoded at the document-byte boundary.
    const result = Schema.decodeUnknownResult(schema.ConfigTranslateDocumentBytes)(input);
    // Then projection customization does not relax decoding.
    expect(Result.isFailure(result)).toBe(true);
  });
  test("requires no ambient services for translation", () => {
    const requiresNothing: TranslateRequiresNothing = true;
    expect(requiresNothing).toBe(true);
  });
  const document = {
    sourceId: "a",
    layerId: "canonical",
    mediaType: "application/yaml",
    contentDigest: `sha256:${"0".repeat(64)}`,
    bytes: "AP+A",
  };
  test("round trips raw bytes when given a document set", () => {
    // Given
    const wire = {
      _tag: "landofile-document-set",
      documents: [document],
      mode: "full",
      selectedSourceIds: ["a"],
      currentLowerV4Fragments: [],
      writableLayerIds: ["canonical"],
    };
    // When
    const decoded = Schema.decodeUnknownSync(schema.ConfigTranslateInput)(wire);
    // Then
    expect(decoded._tag).toBe("landofile-document-set");
    if (decoded._tag === "landofile-document-set")
      expect(decoded.documents[0]?.bytes).toEqual(new Uint8Array([0, 255, 128]));
    expect<unknown>(Schema.encodeSync(schema.ConfigTranslateInput)(decoded)).toEqual(wire);
  });
  test.each([
    [{ _tag: "landofile-document-set", appRoot: "/x" }, false],
    [
      {
        _tag: "recipe-request",
        recipe: { id: "php", version: "1" },
        sourceId: "recipe",
        answers: { php: "8.5" },
        secretAnswers: { pass: { disposition: "postInit.stdin" } },
      },
      true,
    ],
  ])("decodes the tagged input %j", (wire, accepted) => {
    // Given / When
    const result = Schema.decodeUnknownResult(schema.ConfigTranslateInput)(wire);
    // Then
    expect(Result.isSuccess(result)).toBe(accepted);
  });
  test("rejects filesystem context when detecting snapshots", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(schema.ConfigTranslateDetectInput)(
      { documents: [], appRoot: "/x" },
      { onExcessProperty: "error" },
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
  });
  test.each(["generated", "dropped", "rewritten", "unsupported", "non-portable", "needs-review", "info"])(
    "checks diagnostic kind %s",
    (kind) => {
      // Given / When
      const result = Schema.decodeUnknownResult(schema.ConfigTranslateDiagnosticKind)(kind);
      // Then
      expect(Result.isSuccess(result)).toBe(kind !== "info");
    },
  );
  test("rejects malformed content digests", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(schema.ConfigTranslateDocument)({
      ...document,
      contentDigest: "abc",
    });
    // Then
    expect(Result.isFailure(result)).toBe(true);
  });
  test.each([
    "",
    "raw-secret",
    "vault:example",
    "${secret:}",
    "x${secret:API_KEY}",
    "${secret:a}${secret:b}",
  ])("rejects the noncanonical stored-secret reference %s", (reference) => {
    const result = Schema.decodeUnknownResult(schema.ConfigTranslateSecretReference)({
      disposition: "secret-store",
      reference,
    });
    expect(Result.isFailure(result)).toBe(true);
  });
  test.each(["${secret:API_KEY}", "${secret:team/database}"])(
    "accepts the canonical secret-store reference %s",
    (reference) => {
      const result = Schema.decodeUnknownResult(schema.ConfigTranslateSecretReference)({
        disposition: "secret-store",
        reference,
      });
      expect(Result.isSuccess(result)).toBe(true);
    },
  );
});
