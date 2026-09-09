import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { HUGO_RECIPE_VERSION, hugoProducer, hugoSnapshot } from "./snapshot.ts";

export const hugoDecomposer = ((ports) => ({
  producer: hugoProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Hugo recipe input is invalid.");
      if (input.producer.recipeId !== "hugo") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "hugo",
            reason: "missing-recipe",
            message,
            remediation: ports.redactor.redactString("Select the hugo recipe."),
          }),
        );
      }
      const recipeOptions = Object.fromEntries(
        Object.entries(input.options).filter(([key]) => key !== "name"),
      );
      for (const name of Object.keys(recipeOptions)) {
        if (!Object.hasOwn(hugoSnapshot.optionTypes, name)) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "hugo",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(
                `The hugo recipe declares no options; remove ${name}.`,
              ),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "hugo",
        version: HUGO_RECIPE_VERSION,
        producer: hugoProducer,
        options: recipeOptions,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            builder: {
              type: "node:lts",
              command: "npx hugo server --bind 0.0.0.0 --port 1313",
              port: 1313,
            },
            web: {
              type: "static:nginx",
              appMount: { target: "/app" },
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
          },
          tooling: {
            hugo: {
              service: "builder",
              description: "Run the Hugo CLI inside the builder service.",
              cmds: ["npx hugo"],
            },
            npm: { service: "builder", description: "Run npm inside the builder service.", cmds: ["npm"] },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
