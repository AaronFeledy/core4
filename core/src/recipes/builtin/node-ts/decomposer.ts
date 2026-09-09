import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { NODE_TS_RECIPE_VERSION, nodeTsProducer, nodeTsSnapshot } from "./snapshot.ts";

export const nodeTsDecomposer = ((ports) => ({
  producer: nodeTsProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Node-ts recipe input is invalid.");
      if (input.producer.recipeId !== "node-ts") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "node-ts",
            reason: "missing-recipe",
            message,
            remediation: ports.redactor.redactString("Select the node-ts recipe."),
          }),
        );
      }
      for (const name of Object.keys(input.options)) {
        if (!Object.hasOwn(nodeTsSnapshot.optionTypes, name)) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "node-ts",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(
                `The node-ts recipe declares no options; remove ${name}.`,
              ),
            }),
          );
        }
      }
      for (const [name, descriptor] of Object.entries(nodeTsSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "node-ts",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(recipeOptionRemediation(descriptor)),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "node-ts",
        version: NODE_TS_RECIPE_VERSION,
        producer: nodeTsProducer,
        options: input.options,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            web: {
              image: "node:{{ default(env.LANDO_NODE_VERSION, 'lts') }}",
              environment: { NODE_ENV: "{{ default(env.NODE_ENV, 'development') }}" },
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
