import { describe, expect, it } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";

import {
  BUILTIN_RECIPE_DECOMPOSERS,
  builtinRecipeDecomposerIds,
  lookupRecipeDecomposer,
} from "../../src/recipes/builtin/decomposers.ts";

const PHP_WEB_RECIPE_IDS = ["lamp", "lemp", "wordpress", "laravel", "symfony"] as const;

const redactor = createStandaloneRedactor("secrets", { redactionTokens: [] });

describe("bundled recipe decomposers", () => {
  it("ships one decomposer per converted PHP web recipe", () => {
    expect(builtinRecipeDecomposerIds()).toEqual([...PHP_WEB_RECIPE_IDS]);
    expect(BUILTIN_RECIPE_DECOMPOSERS.size).toBe(PHP_WEB_RECIPE_IDS.length);
  });

  it("keys every decomposer by the recipe id its producer records", () => {
    for (const recipeId of PHP_WEB_RECIPE_IDS) {
      const factory = lookupRecipeDecomposer(recipeId);
      expect(factory).toBeDefined();
      const decomposer = factory?.({ redactor });
      expect<unknown>(decomposer?.producer.recipeId).toEqual(recipeId);
      expect<unknown>(decomposer?.producer.sourceKind).toEqual("bundled");
    }
  });

  it("records a distinct versioned content digest for every recipe", () => {
    const digests = PHP_WEB_RECIPE_IDS.map(
      (recipeId) => lookupRecipeDecomposer(recipeId)?.({ redactor }).producer.contentDigest,
    );
    expect(new Set(digests).size).toBe(PHP_WEB_RECIPE_IDS.length);
    for (const digest of digests) expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("returns undefined for a recipe that ships no decomposer", () => {
    expect(lookupRecipeDecomposer("drupal")).toBeUndefined();
  });
});
