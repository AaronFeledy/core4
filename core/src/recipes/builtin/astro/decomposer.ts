import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { ASTRO_RECIPE_VERSION, astroProducer, astroSnapshot } from "./snapshot.ts";

export const astroDecomposer = ((ports) => ({
  producer: astroProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Astro recipe input is invalid.");
      if (input.producer.recipeId !== "astro") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "astro",
            reason: "missing-recipe",
            message,
            remediation: "Select the astro recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(astroSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "astro",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "astro",
        version: ASTRO_RECIPE_VERSION,
        producer: astroProducer,
        options: input.options,
      };
      const hasDatabase = input.options.database !== "none";
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            web: {
              type: "node:{{ recipe.node }}",
              port: 4321,
              environment: { ASTRO_TELEMETRY_DISABLED: "1" },
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
              ...(hasDatabase ? { dependsOn: ["database"] } : {}),
            },
            ...(hasDatabase ? { database: { type: "{{ recipe.database }}" } } : {}),
          },
          tooling: {
            astro: {
              service: "web",
              description: "Run the Astro CLI inside the web service.",
              cmds: ["npx astro"],
            },
            npm: { service: "web", description: "Run npm inside the web service.", cmds: ["npm"] },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
