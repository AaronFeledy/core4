import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { LEMP_RECIPE_VERSION, lempProducer } from "./snapshot.ts";

export const lempDecomposer: RecipeDecomposerFactory = (ports) => ({
  producer: lempProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      if (input.producer.recipeId !== "lemp") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "lemp",
            reason: "missing-recipe",
            message: ports.redactor.redactString("LEMP recipe input has a different recipe id."),
            remediation: ports.redactor.redactString("Select the lemp recipe."),
          }),
        );
      }
      const php = input.options.php;
      if (typeof php !== "string" || (php !== "8.2" && php !== "8.3")) {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "lemp",
            reason: "option-type",
            path: "options.php",
            message: ports.redactor.redactString("LEMP PHP option is invalid."),
            remediation: ports.redactor.redactString("Supply PHP version 8.2 or 8.3 as a string."),
          }),
        );
      }
      const provenance: LandofileRecipeProvenance = {
        id: "lemp",
        version: LEMP_RECIPE_VERSION,
        producer: lempProducer,
        options: input.options,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            web: {
              type: "nginx",
              port: 80,
              dependsOn: ["appserver"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            appserver: { type: "php:{{ recipe.php }}", framework: "none", dependsOn: ["database"] },
            database: { type: "mariadb" },
          },
          tooling: {
            composer: {
              service: "appserver",
              description: "Run Composer inside the appserver service.",
              cmds: ["composer"],
            },
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
});
