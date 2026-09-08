import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { WORDPRESS_RECIPE_VERSION, wordpressProducer, wordpressSnapshot } from "./snapshot.ts";

export const wordpressDecomposer: RecipeDecomposerFactory = (ports) => ({
  producer: wordpressProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("WordPress recipe input is invalid.");
      if (input.producer.recipeId !== "wordpress") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "wordpress",
            reason: "missing-recipe",
            message,
            remediation: "Select the wordpress recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(wordpressSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "wordpress",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "wordpress",
        version: WORDPRESS_RECIPE_VERSION,
        producer: wordpressProducer,
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
              framework: "wordpress",
              port: 80,
              dependsOn: input.options.redis ? ["database", "cache"] : ["database"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "mariadb" },
            ...(input.options.redis ? { cache: { type: "redis" } } : {}),
          },
          tooling: {
            wp: {
              service: "appserver",
              description: "Run WP-CLI inside the appserver service.",
              cmds: ["wp"],
            },
            composer: {
              service: "appserver",
              description: "Run Composer inside the appserver service.",
              cmds: ["composer"],
            },
          },
        },
      };
    }),
});
