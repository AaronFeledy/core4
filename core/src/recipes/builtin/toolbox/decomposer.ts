import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { TOOLBOX_IMAGE } from "./image.ts";
import { TOOLBOX_RECIPE_VERSION, toolboxProducer, toolboxSnapshot } from "./snapshot.ts";

export const toolboxDecomposer = ((ports) => ({
  producer: toolboxProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Toolbox recipe input is invalid.");
      if (input.producer.recipeId !== "toolbox") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "toolbox",
            reason: "missing-recipe",
            message,
            remediation: ports.redactor.redactString("Select the toolbox recipe."),
          }),
        );
      }
      const recipeOptions = Object.fromEntries(
        Object.entries(input.options).filter(([key]) => key !== "name"),
      );
      for (const name of Object.keys(recipeOptions)) {
        if (!Object.hasOwn(toolboxSnapshot.optionTypes, name)) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "toolbox",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(
                `The toolbox recipe declares no options; remove ${name}.`,
              ),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "toolbox",
        version: TOOLBOX_RECIPE_VERSION,
        producer: toolboxProducer,
        options: recipeOptions,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            toolbox: { type: "lando", primary: true, image: TOOLBOX_IMAGE, command: "sleep infinity" },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
