import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { JEKYLL_RECIPE_VERSION, jekyllProducer, jekyllSnapshot } from "./snapshot.ts";

export const jekyllDecomposer = ((ports) => ({
  producer: jekyllProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Jekyll recipe input is invalid.");
      if (input.producer.recipeId !== "jekyll") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "jekyll",
            reason: "missing-recipe",
            message,
            remediation: ports.redactor.redactString("Select the jekyll recipe."),
          }),
        );
      }
      const recipeOptions = Object.fromEntries(
        Object.entries(input.options).filter(([key]) => key !== "name"),
      );
      for (const name of Object.keys(recipeOptions)) {
        if (!Object.hasOwn(jekyllSnapshot.optionTypes, name)) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "jekyll",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(
                `The jekyll recipe declares no options; remove ${name}.`,
              ),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "jekyll",
        version: JEKYLL_RECIPE_VERSION,
        producer: jekyllProducer,
        options: recipeOptions,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            builder: {
              type: "ruby:3.3",
              framework: "none",
              command: "bundle exec jekyll serve --host 0.0.0.0 --port 4000",
              port: 4000,
            },
            web: {
              type: "static:nginx",
              appMount: { target: "/app" },
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
          },
          tooling: {
            jekyll: {
              service: "builder",
              description: "Run the Jekyll CLI inside the builder service.",
              cmds: ["bundle exec jekyll"],
            },
            bundle: {
              service: "builder",
              description: "Run Bundler inside the builder service.",
              cmds: ["bundle"],
            },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
