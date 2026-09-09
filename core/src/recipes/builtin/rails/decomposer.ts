import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { RAILS_RECIPE_VERSION, railsProducer, railsSnapshot } from "./snapshot.ts";

export const railsDecomposer = ((ports) => ({
  producer: railsProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Rails recipe input is invalid.");
      if (input.producer.recipeId !== "rails") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "rails",
            reason: "missing-recipe",
            message,
            remediation: ports.redactor.redactString("Select the rails recipe."),
          }),
        );
      }
      const recipeOptions = Object.fromEntries(
        Object.entries(input.options).filter(([key]) => key !== "name"),
      );
      for (const name of Object.keys(recipeOptions)) {
        if (!Object.hasOwn(railsSnapshot.optionTypes, name)) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "rails",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(
                `The rails recipe declares no options; remove ${name}.`,
              ),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "rails",
        version: RAILS_RECIPE_VERSION,
        producer: railsProducer,
        options: recipeOptions,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            web: {
              type: "ruby:3.3",
              framework: "rails",
              port: 3000,
              build: {
                artifact: [
                  "apt-get update && apt-get install -y --no-install-recommends build-essential",
                  "gem install rails --no-document",
                ],
              },
              dependsOn: ["database", "cache"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "postgres" },
            cache: { type: "redis" },
          },
          tooling: {
            rails: {
              service: "web",
              description: "Run the Rails CLI inside the web service.",
              cmds: ["rails"],
            },
            bundle: {
              service: "web",
              description: "Run Bundler inside the web service.",
              cmds: ["bundle"],
            },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
