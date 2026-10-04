import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { wordpressProducer, wordpressSnapshot } from "./snapshot.ts";

export const wordpressDecomposer: RecipeDecomposerFactory = makeOptionBearingDecomposer({
  producer: wordpressProducer,
  displayName: "WordPress",
  optionTypes: wordpressSnapshot.optionTypes,
  fragment: (input) => {
    return {
      services: {
        appserver: {
          type: "php:{{ recipe.php }}",
          primary: true,
          framework: "wordpress",
          port: 80,
          dependsOn: input.options.redis ? ["database", "cache"] : ["database"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "mariadb" },
        ...(input.options.redis ? { cache: { type: "redis" } } : {}),
      },
      tooling: {
        wp: {
          service: "appserver",
          description: "Run WP-CLI inside the appserver service.",
          cmds: ["wp"],
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
