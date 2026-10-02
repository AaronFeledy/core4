import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { laravelProducer, laravelSnapshot } from "./snapshot.ts";

export const laravelDecomposer: RecipeDecomposerFactory = makeOptionBearingDecomposer({
  producer: laravelProducer,
  displayName: "Laravel",
  optionTypes: laravelSnapshot.optionTypes,
  fragment: (input) => {
    return {
      services: {
        appserver: {
          type: "php:{{ recipe.php }}",
          primary: true,
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
    };
  },
});
