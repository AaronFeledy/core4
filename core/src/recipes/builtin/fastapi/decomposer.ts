import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { FASTAPI_RECIPE_VERSION, fastapiProducer, fastapiSnapshot } from "./snapshot.ts";

export const fastapiDecomposer = ((ports) => ({
  producer: fastapiProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("FastAPI recipe input is invalid.");
      if (input.producer.recipeId !== "fastapi") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "fastapi",
            reason: "missing-recipe",
            message,
            remediation: ports.redactor.redactString("Select the fastapi recipe."),
          }),
        );
      }
      const recipeOptions = Object.fromEntries(
        Object.entries(input.options).filter(([key]) => key !== "name"),
      );
      for (const name of Object.keys(recipeOptions)) {
        if (!Object.hasOwn(fastapiSnapshot.optionTypes, name)) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "fastapi",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(
                `The fastapi recipe declares no options; remove ${name}.`,
              ),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "fastapi",
        version: FASTAPI_RECIPE_VERSION,
        producer: fastapiProducer,
        options: recipeOptions,
      };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            web: {
              type: "python:3.12",
              framework: "fastapi",
              port: 8000,
              dependsOn: ["database", "cache"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "postgres" },
            cache: { type: "redis" },
          },
          tooling: {
            uvicorn: {
              service: "web",
              description: "Run uvicorn inside the web service.",
              cmds: ["uvicorn"],
            },
            pip: { service: "web", description: "Run pip inside the web service.", cmds: ["pip"] },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
