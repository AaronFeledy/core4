import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { LARAVEL_RECIPE_VERSION, laravelProducer, laravelSnapshot } from "./snapshot.ts";

export const laravelDecomposer: RecipeDecomposerFactory = (ports) => ({
  producer: laravelProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Laravel recipe input is invalid.");
      if (input.producer.recipeId !== "laravel") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "laravel",
            reason: "missing-recipe",
            message,
            remediation: "Select the laravel recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(laravelSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "laravel",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "laravel",
        version: LARAVEL_RECIPE_VERSION,
        producer: laravelProducer,
        options: input.options,
      };
      return {
        provenance,
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            appserver: {
              type: "php:{{ recipe.php }}",
              framework: "laravel",
              webroot: "{{ recipe.webroot }}",
              composer: "{{ recipe.composer }}",
              allowOverride: true,
              port: 80,
              dependsOn: ["database", "cache"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "{{ recipe.database }}" },
            cache: { type: "redis" },
            ...(input.options.worker === true
              ? {
                  worker: {
                    type: "php:{{ recipe.php }}",
                    framework: "laravel",
                    via: "cli",
                    command: "php artisan queue:work",
                    dependsOn: ["database", "cache"],
                  },
                }
              : {}),
          },
          tooling: {
            artisan: {
              service: "appserver",
              description: "Run a Laravel Artisan command inside the appserver service.",
              cmds: ["php artisan"],
            },
            composer: {
              service: "appserver",
              description: "Run Composer inside the appserver service.",
              cmds: ["composer"],
            },
            npm: {
              service: "appserver",
              description: "Run npm inside the appserver service.",
              cmds: ["npm"],
            },
          },
        },
      };
    }),
});
