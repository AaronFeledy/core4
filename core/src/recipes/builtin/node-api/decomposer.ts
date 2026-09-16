import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { NODE_API_RECIPE_VERSION, nodeApiProducer, nodeApiSnapshot } from "./snapshot.ts";

export const nodeApiDecomposer = ((ports) => ({
  producer: nodeApiProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Node API recipe input is invalid.");
      if (input.producer.recipeId !== "node-api") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "node-api",
            reason: "missing-recipe",
            message,
            remediation: "Select the node-api recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(nodeApiSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "node-api",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "node-api",
        version: NODE_API_RECIPE_VERSION,
        producer: nodeApiProducer,
        options: input.options,
      };
      const hasDatabase = input.options.database !== "none";
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            api: {
              type: "node:{{ recipe.node }}",
              port: 3000,
              environment: { API_FRAMEWORK: "{{ recipe.framework }}" },
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
              ...(hasDatabase ? { dependsOn: ["database"] } : {}),
            },
            ...(hasDatabase ? { database: { type: "{{ recipe.database }}" } } : {}),
          },
          tooling: {
            npm: { service: "api", description: "Run npm inside the api service.", cmds: ["npm"] },
            node: { service: "api", description: "Run Node inside the api service.", cmds: ["node"] },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
