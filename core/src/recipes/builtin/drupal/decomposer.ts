import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import {
  DRUPAL_RECIPE_VERSION,
  DRUPAL_SCAFFOLD_AUTHORING_COMMAND,
  drupalProducer,
  drupalSnapshot,
} from "./snapshot.ts";

const primaryRoutes = [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }];

export const drupalDecomposer = ((ports) => ({
  producer: drupalProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Drupal recipe input is invalid.");
      if (input.producer.recipeId !== "drupal") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "drupal",
            reason: "missing-recipe",
            message,
            remediation: "Select the drupal recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(drupalSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "drupal",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "drupal",
        version: DRUPAL_RECIPE_VERSION,
        producer: drupalProducer,
        options: input.options,
      };
      const nginx = input.options.webserver === "nginx";
      const database = { type: "{{ recipe.database }}" };
      return {
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: nginx
            ? {
                appserver: {
                  type: "php:{{ recipe.php }}",
                  framework: "drupal",
                  via: "fpm",
                  webroot: "{{ recipe.webroot }}",
                  composer: "{{ recipe.composer }}",
                  dependsOn: ["database"],
                },
                edge: {
                  type: "nginx",
                  backend: "appserver",
                  webroot: "{{ recipe.webroot }}",
                  routes: primaryRoutes,
                },
                database,
              }
            : {
                appserver: {
                  type: "php:{{ recipe.php }}",
                  framework: "drupal",
                  webroot: "{{ recipe.webroot }}",
                  composer: "{{ recipe.composer }}",
                  allowOverride: true,
                  port: 80,
                  dependsOn: ["database"],
                  routes: primaryRoutes,
                },
                database,
              },
          tooling: {
            drush: {
              service: "appserver",
              description: "Run Drush inside the appserver service.",
              cmds: ["vendor/bin/drush"],
            },
            composer: {
              service: "appserver",
              description: "Run Composer inside the appserver service.",
              cmds: ["composer"],
            },
            "drupal-scaffold": {
              service: "appserver",
              description: "Scaffold Drupal and project-local Drush into the mounted app root.",
              arguments: false,
              cmd: DRUPAL_SCAFFOLD_AUTHORING_COMMAND,
            },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
