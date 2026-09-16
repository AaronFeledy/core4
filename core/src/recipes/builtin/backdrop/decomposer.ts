import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import {
  BACKDROP_RECIPE_VERSION,
  BACKDROP_SETTINGS_VALUE,
  backdropProducer,
  backdropSnapshot,
} from "./snapshot.ts";

export const backdropDecomposer = ((ports) => ({
  producer: backdropProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Backdrop recipe input is invalid.");
      if (input.producer.recipeId !== "backdrop") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "backdrop",
            reason: "missing-recipe",
            message,
            remediation: "Select the backdrop recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(backdropSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "backdrop",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "backdrop",
        version: BACKDROP_RECIPE_VERSION,
        producer: backdropProducer,
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
              framework: "backdrop",
              webroot: "{{ recipe.webroot }}",
              composer: composerEnabled ? "{{ recipe.composer }}" : false,
              allowOverride: true,
              port: 80,
              dependsOn: ["database"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
              environment: { BACKDROP_SETTINGS: BACKDROP_SETTINGS_VALUE },
            },
            database: { type: "{{ recipe.database }}" },
          },
          tooling: {
            bee: {
              service: "appserver",
              description: "Run Bee inside the appserver service.",
              cmds: ["bee"],
            },
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
