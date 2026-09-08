import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { WORDPRESS_RECIPE_VERSION, wordpressProducer } from "./snapshot.ts";

export const wordpressDecomposer: RecipeDecomposerFactory = (ports) => ({
  producer: wordpressProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      if (input.producer.recipeId !== "wordpress") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "wordpress",
            reason: "missing-recipe",
            message: ports.redactor.redactString("The requested recipe is not WordPress."),
            remediation: "Select the wordpress recipe.",
          }),
        );
      }
      if (input.options.php !== "8.2" && input.options.php !== "8.3") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "wordpress",
            reason: "option-type",
            path: "options.php",
            message: ports.redactor.redactString("The WordPress PHP option is invalid."),
            remediation: "Supply PHP as the string 8.2 or 8.3.",
          }),
        );
      }
      if (typeof input.options.redis !== "boolean") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "wordpress",
            reason: "option-type",
            path: "options.redis",
            message: ports.redactor.redactString("The WordPress Redis option is invalid."),
            remediation: "Supply redis as a boolean.",
          }),
        );
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
