import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { SYMFONY_RECIPE_VERSION, symfonyProducer, symfonySnapshot } from "./snapshot.ts";

export const symfonyDecomposer: RecipeDecomposerFactory = (ports) => ({
  producer: symfonyProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Symfony recipe input is invalid.");
      if (input.producer.recipeId !== "symfony") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "symfony",
            reason: "missing-recipe",
            message,
            remediation: "Select the symfony recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(symfonySnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "symfony",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "symfony",
        version: SYMFONY_RECIPE_VERSION,
        producer: symfonyProducer,
        options: input.options,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            appserver: {
              type: "php:{{ recipe.php }}",
              framework: "symfony",
              webroot: "{{ recipe.webroot }}",
              composer: "{{ recipe.composer }}",
              allowOverride: true,
              port: 80,
              dependsOn: ["database", "cache"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "{{ recipe.database }}" },
            cache: { type: "redis" },
          },
          tooling: {
            console: {
              service: "appserver",
              description: "Run the Symfony console inside the appserver service.",
              cmds: ["php bin/console"],
            },
            composer: {
              service: "appserver",
              description: "Run Composer inside the appserver service.",
              cmds: ["composer"],
            },
          },
        },
        provenance,
      };
    }),
});
