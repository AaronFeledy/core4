import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { MEAN_RECIPE_VERSION, meanProducer, meanSnapshot } from "./snapshot.ts";

export const meanDecomposer = ((ports) => ({
  producer: meanProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("MEAN recipe input is invalid.");
      if (input.producer.recipeId !== "mean") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "mean",
            reason: "missing-recipe",
            message,
            remediation: "Select the mean recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(meanSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "mean",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "mean",
        version: MEAN_RECIPE_VERSION,
        producer: meanProducer,
        options: input.options,
      };
      const redis = input.options.redis === true;
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            api: {
              type: "node:{{ recipe.node }}",
              port: 3000,
              environment: {
                NODE_ENV: "development",
                PORT: 3000,
                MONGO_URL: "mongodb://lando:lando@database:27017/{{ app.name }}?authSource=admin",
                ...(redis ? { REDIS_URL: "redis://cache:6379" } : {}),
              },
              dependsOn: redis ? ["database", "cache"] : ["database"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "mongodb" },
            ...(redis ? { cache: { type: "redis" } } : {}),
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
