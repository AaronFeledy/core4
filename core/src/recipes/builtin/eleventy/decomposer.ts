import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { ELEVENTY_RECIPE_VERSION, eleventyProducer, eleventySnapshot } from "./snapshot.ts";

export const eleventyDecomposer = ((ports) => ({
  producer: eleventyProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Eleventy recipe input is invalid.");
      if (input.producer.recipeId !== "eleventy") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "eleventy",
            reason: "missing-recipe",
            message,
            remediation: ports.redactor.redactString("Select the eleventy recipe."),
          }),
        );
      }
      const recipeOptions = Object.fromEntries(
        Object.entries(input.options).filter(([key]) => key !== "name"),
      );
      for (const name of Object.keys(recipeOptions)) {
        if (!Object.hasOwn(eleventySnapshot.optionTypes, name)) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "eleventy",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(
                `The eleventy recipe declares no options; remove ${name}.`,
              ),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "eleventy",
        version: ELEVENTY_RECIPE_VERSION,
        producer: eleventyProducer,
        options: recipeOptions,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            builder: {
              type: "node:lts",
              command: "npx @11ty/eleventy --serve --port 8080",
              port: 8080,
            },
            web: {
              type: "static:nginx",
              appMount: { target: "/app" },
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
          },
          tooling: {
            eleventy: {
              service: "builder",
              description: "Run the Eleventy CLI inside the builder service.",
              cmds: ["npx @11ty/eleventy"],
            },
            npm: { service: "builder", description: "Run npm inside the builder service.", cmds: ["npm"] },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
