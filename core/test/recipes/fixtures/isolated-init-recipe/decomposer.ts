import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance, RecipeDecomposeInput } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { ISOLATED_RECIPE_ID, ISOLATED_RECIPE_PRODUCER, ISOLATED_RECIPE_VERSION } from "./manifest.ts";

export const isolatedInitDecomposer: RecipeDecomposerFactory = (ports) => ({
  producer: ISOLATED_RECIPE_PRODUCER,
  decompose: (input: RecipeDecomposeInput) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Isolated init recipe input is invalid.");
      if (input.producer.recipeId !== ISOLATED_RECIPE_ID) {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: ISOLATED_RECIPE_ID,
            reason: "missing-recipe",
            message,
            remediation: "Select the isolated-init test recipe.",
          }),
        );
      }
      if (typeof input.options.php !== "string") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: ISOLATED_RECIPE_ID,
            reason: "option-type",
            path: "options.php",
            message,
            remediation: "Supply the PHP version as a string.",
          }),
        );
      }
      const provenance: LandofileRecipeProvenance = {
        id: ISOLATED_RECIPE_ID,
        version: ISOLATED_RECIPE_VERSION,
        producer: ISOLATED_RECIPE_PRODUCER,
        options: input.options,
      };
      return {
        fragment: {
          name: ISOLATED_RECIPE_ID,
          recipe: provenance,
          services: {
            appserver: { type: "php:{{ recipe.php }}", webroot: "{{ recipe.webroot }}" },
          },
        },
        provenance,
      };
    }),
});
