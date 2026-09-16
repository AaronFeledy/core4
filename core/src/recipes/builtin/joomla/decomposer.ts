import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { JOOMLA_RECIPE_VERSION, joomlaProducer, joomlaSnapshot } from "./snapshot.ts";

export const joomlaDecomposer = ((ports) => ({
  producer: joomlaProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Joomla recipe input is invalid.");
      if (input.producer.recipeId !== "joomla") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "joomla",
            reason: "missing-recipe",
            message,
            remediation: "Select the joomla recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(joomlaSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "joomla",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "joomla",
        version: JOOMLA_RECIPE_VERSION,
        producer: joomlaProducer,
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
              framework: "joomla",
              webroot: "{{ recipe.webroot }}",
              composer: composerEnabled ? "{{ recipe.composer }}" : false,
              allowOverride: true,
              port: 80,
              dependsOn: ["database"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "{{ recipe.database }}" },
          },
          tooling: {
            joomla: {
              service: "appserver",
              description: "Run the Joomla CLI inside the appserver service.",
              cmds: ["php cli/joomla.php"],
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
