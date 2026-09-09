import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { NODE_POSTGRES_RECIPE_VERSION, nodePostgresProducer, nodePostgresSnapshot } from "./snapshot.ts";

export const nodePostgresDecomposer = ((ports) => ({
  producer: nodePostgresProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Node-postgres recipe input is invalid.");
      if (input.producer.recipeId !== "node-postgres") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "node-postgres",
            reason: "missing-recipe",
            message,
            remediation: ports.redactor.redactString("Select the node-postgres recipe."),
          }),
        );
      }
      const recipeOptions = Object.fromEntries(
        Object.entries(input.options).filter(([key]) => key !== "name"),
      );
      for (const name of Object.keys(recipeOptions)) {
        if (!Object.hasOwn(nodePostgresSnapshot.optionTypes, name)) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "node-postgres",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(
                `The node-postgres recipe declares no options; remove ${name}.`,
              ),
            }),
          );
        }
      }
      for (const [name, descriptor] of Object.entries(nodePostgresSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, recipeOptions[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "node-postgres",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(recipeOptionRemediation(descriptor)),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "node-postgres",
        version: NODE_POSTGRES_RECIPE_VERSION,
        producer: nodePostgresProducer,
        options: recipeOptions,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            web: {
              type: "node:lts",
              ports: ["3000:3000"],
              environment: { NODE_ENV: "development" },
              volumes: ["./:/app"],
              command: "node /app/server.js",
              dependsOn: ["database"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "postgres" },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
