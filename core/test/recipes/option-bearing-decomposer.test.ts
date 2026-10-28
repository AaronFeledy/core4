import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { renderRecipeSnapshot } from "@lando/sdk/recipes";
import { Effect, Result } from "effect";
import { BUILTIN_RECIPE_DECOMPOSERS } from "../../src/recipes/builtin/decomposers.ts";
import { recipeOptionRemediation } from "../../src/recipes/builtin/option-remediation.ts";
import { bundledRecipe } from "../_support/bundled-recipe.ts";

const redactor = createStandaloneRedactor("secrets", { redactionTokens: ["private-answer"] });
for (const recipeId of BUILTIN_RECIPE_DECOMPOSERS.keys()) {
  const { decomposer: factory, snapshot } = bundledRecipe(recipeId);
  if (Object.keys(snapshot.optionTypes).length === 0) continue;
  const decomposer = factory({ redactor });
  const input = { producer: decomposer.producer, options: snapshot.defaults, secrets: {} };
  describe(`${recipeId} compiled option boundaries`, () => {
    test("omits reserved app name and applies declared defaults without changing authoring", () => {
      const result = Effect.runSync(decomposer.decompose({ ...input, options: { name: "my-app" } }));
      const { recipe, ...authoring } = result.fragment;
      expect<unknown>(authoring).toEqual(
        Result.getOrThrow(renderRecipeSnapshot(snapshot, snapshot.defaults)),
      );
      expect(result.provenance.options).toEqual(snapshot.defaults);
      expect(recipe).toEqual(result.provenance);
    });
    test("rejects undeclared options rather than persisting them", () => {
      const error = Effect.runSync(
        Effect.flip(
          decomposer.decompose({ ...input, options: { ...snapshot.defaults, extension: "private-answer" } }),
        ),
      );
      expect(error).toMatchObject({
        _tag: "RecipeDecomposeError",
        recipeId,
        reason: "option-type",
        path: "options.extension",
      });
      expect(JSON.stringify(error)).not.toContain("private-answer");
    });
    test("rejects a different exact producer before rendering", () => {
      const error = Effect.runSync(
        Effect.flip(
          decomposer.decompose({
            ...input,
            producer: { ...input.producer, contentDigest: `sha256:${"f".repeat(64)}` },
          }),
        ),
      );
      expect(error).toMatchObject({
        _tag: "RecipeDecomposeError",
        recipeId,
        reason: "missing-recipe",
        path: "producer",
      });
    });
    for (const [name, descriptor] of Object.entries(snapshot.optionTypes)) {
      test(`reports the descriptor and path when ${name} is malformed`, () => {
        const error = Effect.runSync(
          Effect.flip(decomposer.decompose({ ...input, options: { ...snapshot.defaults, [name]: [] } })),
        );
        expect(error).toMatchObject({
          _tag: "RecipeDecomposeError",
          recipeId,
          reason: "option-type",
          path: `options.${name}`,
          remediation: recipeOptionRemediation(descriptor),
        });
      });
    }
  });
}
