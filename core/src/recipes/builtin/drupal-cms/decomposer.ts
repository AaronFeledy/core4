import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "../option-remediation.ts";
import { DRUPAL_CMS_SCAFFOLD_COMMAND } from "./commands.ts";
import {
  DRUPAL_CMS_MYSQL_INSTALL_COMMAND,
  DRUPAL_CMS_PGSQL_INSTALL_COMMAND,
  DRUPAL_CMS_POSTGRES_DATABASE,
  DRUPAL_CMS_RECIPE_VERSION,
  drupalCmsProducer,
  drupalCmsSnapshot,
} from "./snapshot.ts";

const primaryRoutes = [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }];

export const drupalCmsDecomposer = ((ports) => ({
  producer: drupalCmsProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      const message = ports.redactor.redactString("Drupal CMS recipe input is invalid.");
      if (input.producer.recipeId !== "drupal-cms") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "drupal-cms",
            reason: "missing-recipe",
            message,
            remediation: "Select the drupal-cms recipe.",
          }),
        );
      }
      for (const [name, descriptor] of Object.entries(drupalCmsSnapshot.optionTypes)) {
        if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "drupal-cms",
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: recipeOptionRemediation(descriptor),
            }),
          );
        }
      }
      const provenance: LandofileRecipeProvenance = {
        id: "drupal-cms",
        version: DRUPAL_CMS_RECIPE_VERSION,
        producer: drupalCmsProducer,
        options: input.options,
      };
      const nginx = input.options.webserver === "nginx";
      const database = { type: "{{ recipe.database }}", database: "{{ app.name }}" };
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
            "drupal-cms-scaffold": {
              service: "appserver",
              description: "Scaffold Drupal CMS 2 and project-local Drush into the mounted app root.",
              arguments: false,
              cmd: DRUPAL_CMS_SCAFFOLD_COMMAND,
            },
            "drupal-cms-install": {
              service: "appserver",
              description: "Install Drupal CMS 2 using the drupal_cms_starter recipe.",
              arguments: false,
              cmd:
                input.options.database === DRUPAL_CMS_POSTGRES_DATABASE
                  ? DRUPAL_CMS_PGSQL_INSTALL_COMMAND
                  : DRUPAL_CMS_MYSQL_INSTALL_COMMAND,
            },
          },
        },
        provenance,
      };
    }),
})) satisfies RecipeDecomposerFactory;
