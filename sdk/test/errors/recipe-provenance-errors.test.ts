import { describe, expect, test } from "bun:test";

import {
  RecipeDecomposeError,
  RecipeMigrationChainError,
  RecipeProvenanceError,
  RecipeSecretDispositionError,
  RecipeSecretSinkError,
  RecipeSnapshotError,
} from "@lando/sdk/errors";
import { Either, Schema } from "effect";

describe("recipe provenance errors", () => {
  test("RecipeSecretSinkError carries only structural fields", () => {
    expect(Object.keys(RecipeSecretSinkError.fields).sort()).toEqual(
      ["_tag", "message", "remediation", "recipeId", "promptName", "sink", "sinkName", "stage"].sort(),
    );
    expect("cause" in RecipeSecretSinkError.fields).toBe(false);
  });

  test("every new recipe error exposes a machine tag and remediation", () => {
    const errors = [
      [
        "RecipeDecomposeError",
        new RecipeDecomposeError({
          message: "Recipe is missing.",
          remediation: "Install the recipe.",
          recipeId: "example",
          reason: "missing-recipe",
        }),
      ],
      [
        "RecipeProvenanceError",
        new RecipeProvenanceError({
          message: "Recipe provenance is malformed.",
          remediation: "Regenerate recipe provenance.",
          reason: "malformed",
        }),
      ],
      [
        "RecipeSnapshotError",
        new RecipeSnapshotError({
          message: "Recipe snapshot is missing.",
          remediation: "Restore the recipe snapshot.",
          recipeId: "example",
          reason: "missing-snapshot",
        }),
      ],
      [
        "RecipeMigrationChainError",
        new RecipeMigrationChainError({
          message: "Migration chain has a gap.",
          remediation: "Supply the missing migration.",
          family: "example",
          reason: "gap",
        }),
      ],
      [
        "RecipeSecretDispositionError",
        new RecipeSecretDispositionError({
          message: "Secret disposition is missing.",
          remediation: "Declare one secret disposition.",
          recipeId: "example",
          promptName: "token",
          reason: "missing",
        }),
      ],
      [
        "RecipeSecretSinkError",
        new RecipeSecretSinkError({
          message: "Secret delivery failed.",
          remediation: "Check the post-init sink configuration.",
          recipeId: "example",
          promptName: "token",
          sink: "postInit.stdin",
          stage: "deliver",
        }),
      ],
    ] as const;

    for (const [tag, error] of errors) {
      expect(error._tag).toBe(tag);
      expect(typeof error.remediation).toBe("string");
      expect(error.remediation.length).toBeGreaterThan(0);
    }
  });

  test("closed reason literals reject an unknown reason", () => {
    const decompose = Schema.decodeUnknownEither(RecipeDecomposeError)({
      _tag: "RecipeDecomposeError",
      message: "Invalid decomposition.",
      remediation: "Check the recipe options.",
      recipeId: "example",
      reason: "unknown-reason",
    });
    const provenance = Schema.decodeUnknownEither(RecipeProvenanceError)({
      _tag: "RecipeProvenanceError",
      message: "Invalid provenance.",
      remediation: "Regenerate recipe provenance.",
      reason: "unknown-reason",
    });

    expect(Either.isLeft(decompose)).toBe(true);
    expect(Either.isLeft(provenance)).toBe(true);
  });
});
