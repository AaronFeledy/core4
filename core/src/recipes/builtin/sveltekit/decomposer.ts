import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { SVELTEKIT_RECIPE_VERSION, sveltekitProducer, sveltekitSnapshot } from "./snapshot.ts";

export const sveltekitDecomposer = ((ports) => ({
  producer: sveltekitProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("SvelteKit recipe input is invalid.");
      if (input.producer.recipeId !== "sveltekit") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "sveltekit",
            reason: "missing-recipe",
            message,
            remediation: "Select the sveltekit recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(sveltekitSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "sveltekit",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "sveltekit",
        version: SVELTEKIT_RECIPE_VERSION,
        producer: sveltekitProducer,
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
              port: 5173,
              environment: { SVELTEKIT_ADAPTER: "{{ recipe.adapter }}" },
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
              ...(hasDatabase ? { dependsOn: ["database"] } : {}),
            },
            ...(hasDatabase ? { database: { type: "{{ recipe.database }}" } } : {}),
          },
          tooling: {
            svelte: {
              service: "web",
              description: "Run the Svelte CLI inside the web service.",
              cmds: ["npx svelte-kit"],
            },
            npm: { service: "web", description: "Run npm inside the web service.", cmds: ["npm"] },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
