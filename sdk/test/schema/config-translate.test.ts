import { describe, expect, test } from "bun:test";
import * as schema from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { type Effect, Either, Schema } from "effect";

// ==== Static service contract
type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type TranslateRequiresNothing = Assert<
  Equal<Effect.Effect.Context<ReturnType<ConfigTranslatorShape["translate"]>>, never>
>;

// ==== Snapshot wire contracts
describe("config translation schemas", () => {
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
    const result = Schema.decodeUnknownEither(schema.ConfigTranslateInput)(wire);
    // Then
    expect(Either.isRight(result)).toBe(accepted);
  });
  test("rejects filesystem context when detecting snapshots", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(schema.ConfigTranslateDetectInput)(
      { documents: [], appRoot: "/x" },
      { onExcessProperty: "error" },
    );
    // Then
    expect(Either.isLeft(result)).toBe(true);
  });
  test.each(["generated", "dropped", "rewritten", "unsupported", "non-portable", "needs-review", "info"])(
    "checks diagnostic kind %s",
    (kind) => {
      // Given / When
      const result = Schema.decodeUnknownEither(schema.ConfigTranslateDiagnosticKind)(kind);
      // Then
      expect(Either.isRight(result)).toBe(kind !== "info");
    },
  );
  test("rejects malformed content digests", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(schema.ConfigTranslateDocument)({
      ...document,
      contentDigest: "abc",
    });
    // Then
    expect(Either.isLeft(result)).toBe(true);
  });
  test.each([
    "",
    "raw-secret",
    "vault:example",
    "${secret:}",
    "x${secret:API_KEY}",
    "${secret:a}${secret:b}",
  ])("rejects the noncanonical stored-secret reference %s", (reference) => {
    const result = Schema.decodeUnknownEither(schema.ConfigTranslateSecretReference)({
      disposition: "secret-store",
      reference,
    });
    expect(Either.isLeft(result)).toBe(true);
  });
  test.each(["${secret:API_KEY}", "${secret:team/database}"])(
    "accepts the canonical secret-store reference %s",
    (reference) => {
      const result = Schema.decodeUnknownEither(schema.ConfigTranslateSecretReference)({
        disposition: "secret-store",
        reference,
      });
      expect(Either.isRight(result)).toBe(true);
    },
  );
});
