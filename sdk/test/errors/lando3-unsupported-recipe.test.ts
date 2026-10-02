import { describe, expect, it } from "bun:test";

import { ConfigTranslateError, Lando3UnsupportedRecipeError } from "@lando/sdk/errors";
import { Schema } from "effect";

const payload = {
  message: "The Lando 3 recipe has no bundled Lando 4 counterpart.",
  remediation:
    "Recipe id and source layer; run the app with Lando 3 or replace the recipe with explicit v4 services before conversion.",
  recipeId: "pantheon",
  sourceLayer: ".lando.yml",
  reason: "hoster",
  keyPath: ["recipe"],
} as const;

describe("Lando3UnsupportedRecipeError", () => {
  it("preserves its tag and every supplied field when constructed", () => {
    // Given / When
    const error = new Lando3UnsupportedRecipeError(payload);

    // Then
    expect(error._tag).toBe("Lando3UnsupportedRecipeError");
    expect(error.message).toBe(payload.message);
    expect(error.remediation).toBe(payload.remediation);
    expect(error.recipeId).toBe(payload.recipeId);
    expect(error.sourceLayer).toBe(payload.sourceLayer);
    expect(error.reason).toBe(payload.reason);
    expect(error.keyPath).toEqual(payload.keyPath);
  });

  it.each(["hoster", "unknown", "non-string", "no-v4-version", "invalid-option"] as const)(
    "constructs when reason is %s",
    (reason) => {
      // Given / When
      const error = new Lando3UnsupportedRecipeError({ ...payload, reason });

      // Then
      expect(error.reason).toBe(reason);
    },
  );

  it("rejects an invalid reason when decoding unknown input", () => {
    // Given
    const input = { ...payload, _tag: "Lando3UnsupportedRecipeError", reason: "invalid" };

    // When / Then
    expect(() => Schema.decodeUnknownSync(Lando3UnsupportedRecipeError)(input)).toThrow();
  });

  it("preserves the error when carried by ConfigTranslateError.cause", () => {
    // Given
    const cause = new Lando3UnsupportedRecipeError(payload);

    // When
    const error = new ConfigTranslateError({ message: "Translation failed.", cause });

    // Then
    expect(error.cause).toBe(cause);
    expect((error.cause as { _tag: string })._tag).toBe("Lando3UnsupportedRecipeError");
  });
});
