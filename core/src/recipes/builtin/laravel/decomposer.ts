import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { DRUPAL_COMPOSER_OPTIONS, LARAVEL_DATABASES, PHP_VERSIONS, WEBROOT_PATTERN } from "../php-stack";
import { LARAVEL_RECIPE_VERSION, laravelProducer } from "./snapshot.ts";

export const laravelDecomposer: RecipeDecomposerFactory = (ports) => ({
  producer: laravelProducer,
  decompose: (input) =>
    Effect.gen(function* () {
      if (input.producer.recipeId !== "laravel") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "laravel",
            reason: "missing-recipe",
            message: ports.redactor.redactString("Laravel recipe was not selected."),
            remediation: "Select the laravel recipe.",
          }),
        );
      }
      const choices: Readonly<Record<string, readonly string[]>> = {
        php: PHP_VERSIONS,
        database: LARAVEL_DATABASES,
        composer: DRUPAL_COMPOSER_OPTIONS,
      };
      for (const [name, values] of Object.entries(choices)) {
        const value = input.options[name];
        if (typeof value !== "string" || !values.includes(value)) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId: "laravel",
              reason: "option-type",
              path: `options.${name}`,
              message: ports.redactor.redactString(`Invalid Laravel ${name} option.`),
              remediation: "Supply a supported string option value.",
            }),
          );
        }
      }
      if (typeof input.options.webroot !== "string" || !WEBROOT_PATTERN.test(input.options.webroot)) {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "laravel",
            reason: "option-type",
            path: "options.webroot",
            message: ports.redactor.redactString("Invalid Laravel webroot option."),
            remediation:
              "Supply an absolute container path using letters, digits, dots, underscores, slashes, or hyphens.",
          }),
        );
      }
      if (typeof input.options.worker !== "boolean") {
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: "laravel",
            reason: "option-type",
            path: "options.worker",
            message: ports.redactor.redactString("Invalid Laravel worker option."),
            remediation: "Supply a boolean worker option.",
          }),
        );
      }
      const provenance: LandofileRecipeProvenance = {
        id: "laravel",
        version: LARAVEL_RECIPE_VERSION,
        producer: laravelProducer,
        options: input.options,
      };
      return {
        provenance,
        fragment: {
          runtime: 4,
          recipe: provenance,
          services: {
            appserver: {
              type: "php:{{ recipe.php }}",
              framework: "laravel",
              webroot: "{{ recipe.webroot }}",
              composer: "{{ recipe.composer }}",
              allowOverride: true,
              port: 80,
              dependsOn: ["database", "cache"],
              routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
            },
            database: { type: "{{ recipe.database }}" },
            cache: { type: "redis" },
            ...(input.options.worker === true
              ? {
                  worker: {
                    type: "php:{{ recipe.php }}",
                    framework: "laravel",
                    via: "cli",
                    command: "php artisan queue:work",
                    dependsOn: ["database", "cache"],
                  },
                }
              : {}),
          },
          tooling: {
            artisan: {
              service: "appserver",
              description: "Run a Laravel Artisan command inside the appserver service.",
              cmds: ["php artisan"],
            },
            composer: {
              service: "appserver",
              description: "Run Composer inside the appserver service.",
              cmds: ["composer"],
            },
            npm: {
              service: "appserver",
              description: "Run npm inside the appserver service.",
              cmds: ["npm"],
            },
          },
        },
      };
    }),
});
