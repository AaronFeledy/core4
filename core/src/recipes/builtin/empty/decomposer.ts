import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { EMPTY_RECIPE_VERSION, emptyProducer, emptySnapshot } from "./snapshot.ts";

export const emptyDecomposer = ((ports) => ({
  producer: emptyProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Empty Landofile recipe input is invalid.");
      if (input.producer.recipeId !== "empty") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "empty",
            reason: "missing-recipe",
            message,
            remediation: ports.redactor.redactString("Select the empty recipe."),
          }),
        );
      }
      const recipeOptions = Object.fromEntries(
        Object.entries(input.options).filter(([key]) => key !== "name"),
      );
      for (const name of Object.keys(recipeOptions)) {
        if (!Object.hasOwn(emptySnapshot.optionTypes, name)) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "empty",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(
                `The empty recipe declares no options; remove ${name}.`,
              ),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "empty",
        version: EMPTY_RECIPE_VERSION,
        producer: emptyProducer,
        options: recipeOptions,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
