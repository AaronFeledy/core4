import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { symfonyProducer, symfonySnapshot } from "./snapshot.ts";

export const symfonyDecomposer: RecipeDecomposerFactory = makeOptionBearingDecomposer({
  producer: symfonyProducer,
  displayName: "Symfony",
  optionTypes: symfonySnapshot.optionTypes,
  fragment: () => {
    return {
      services: {
        appserver: {
          type: "php:{{ recipe.php }}",
          primary: true,
          framework: "symfony",
          webroot: "{{ recipe.webroot }}",
          composer: "{{ recipe.composer }}",
          allowOverride: true,
          port: 80,
          dependsOn: ["database", "cache"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "{{ recipe.database }}" },
        cache: { type: "redis" },
      },
      tooling: {
        console: {
          service: "appserver",
          description: "Run the Symfony console inside the appserver service.",
          cmds: ["php bin/console"],
        },
        composer: {
          service: "appserver",
          description: "Run Composer inside the appserver service.",
          cmds: ["composer"],
        },
      },
    };
  },
});
