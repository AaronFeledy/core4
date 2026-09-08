import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { LAMP_RECIPE_VERSION, lampProducer, lampSnapshot } from "./snapshot.ts";

export const lampDecomposer = ((ports) => ({
  producer: lampProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("LAMP recipe input is invalid.");
      if (input.producer.recipeId !== "lamp") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "lamp",
            reason: "missing-recipe",
            message,
            remediation: "Select the lamp recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(lampSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "lamp",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: "Supply a string matching the LAMP option's declared choices or path pattern.",
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "lamp",
        version: LAMP_RECIPE_VERSION,
        producer: lampProducer,
        options: input.options,
      };
      const composerEnabled = input.options.composer !== "false";
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            appserver: {
              type: "php:{{ recipe.php }}",
              framework: "none",
              webroot: "{{ recipe.webroot }}",
              composer: composerEnabled ? "{{ recipe.composer }}" : false,
              port: 80,
              dependsOn: ["database"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "{{ recipe.database }}" },
          },
          tooling: {
            ...(composerEnabled
              ? {
                  composer: {
                    service: "appserver",
                    description: "Run Composer inside the appserver service.",
                    cmds: ["composer"],
                  },
                }
              : {}),
            php: {
              service: "appserver",
              description: "Run the PHP CLI inside the appserver service.",
              cmds: ["php"],
            },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
