import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { LEMP_RECIPE_VERSION, lempProducer, lempSnapshot } from "./snapshot.ts";

export const lempDecomposer: RecipeDecomposerFactory = (ports) => ({
  producer: lempProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("LEMP recipe input is invalid.");
      if (input.producer.recipeId !== "lemp") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "lemp",
            reason: "missing-recipe",
            message,
            remediation: "Select the lemp recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(lempSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "lemp",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
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
