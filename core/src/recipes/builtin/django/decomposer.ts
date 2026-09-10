import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { DJANGO_RECIPE_VERSION, djangoProducer, djangoSnapshot } from "./snapshot.ts";

export const djangoDecomposer = ((ports) => ({
  producer: djangoProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Django recipe input is invalid.");
      if (input.producer.recipeId !== "django") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "django",
            reason: "missing-recipe",
            message,
            remediation: "Select the django recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(djangoSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "django",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "django",
        version: DJANGO_RECIPE_VERSION,
        producer: djangoProducer,
        options: input.options,
      };
      const hasWorker = input.options.celery === true;
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            web: {
              type: "python:3.12",
              framework: "django",
              port: 8000,
              dependsOn: ["database", "cache"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "postgres" },
            cache: { type: "redis" },
            ...(hasWorker
              ? {
                  worker: {
                    type: "python:3.12",
                    framework: "django",
                    command: "celery -A app worker --loglevel=info",
                    dependsOn: ["database", "cache"],
                  },
                }
              : {}),
          },
          tooling: {
            django: {
              service: "web",
              description: "Run the Django management script inside the web service.",
              cmds: ["python manage.py"],
            },
            pip: { service: "web", description: "Run pip inside the web service.", cmds: ["pip"] },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
