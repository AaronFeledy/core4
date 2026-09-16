import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { NEXTJS_RECIPE_VERSION, nextjsProducer, nextjsSnapshot } from "./snapshot.ts";

export const nextjsDecomposer = ((ports) => ({
  producer: nextjsProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Next.js recipe input is invalid.");
      if (input.producer.recipeId !== "nextjs") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "nextjs",
            reason: "missing-recipe",
            message,
            remediation: "Select the nextjs recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(nextjsSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "nextjs",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "nextjs",
        version: NEXTJS_RECIPE_VERSION,
        producer: nextjsProducer,
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
              port: 3000,
              environment: { NEXTAUTH_PROVIDER: "{{ recipe.auth }}" },
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
              ...(hasDatabase ? { dependsOn: ["database"] } : {}),
            },
            ...(hasDatabase ? { database: { type: "{{ recipe.database }}" } } : {}),
          },
          tooling: {
            next: {
              service: "web",
              description: "Run the Next.js CLI inside the web service.",
              cmds: ["npx next"],
            },
            npm: { service: "web", description: "Run npm inside the web service.", cmds: ["npm"] },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
