import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { lempProducer, lempSnapshot } from "./snapshot.ts";

export const lempDecomposer: RecipeDecomposerFactory = makeOptionBearingDecomposer({
  producer: lempProducer,
  displayName: "LEMP",
  optionTypes: lempSnapshot.optionTypes,
  fragment: () => {
    return {
      services: {
        web: {
          primary: false,
          type: "nginx",
          backend: "appserver",
          webroot: "/app",
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        appserver: {
          type: "php:{{ recipe.php }}",
          primary: true,
          framework: "none",
          via: "fpm",
          webroot: "/app",
          dependsOn: ["database"],
        },
        database: { type: "mariadb" },
      },
      tooling: {
        composer: {
          service: "appserver",
          description: "Run Composer inside the appserver service.",
          cmds: ["composer"],
        },
        php: {
          service: "appserver",
          description: "Run the PHP CLI inside the appserver service.",
          cmds: ["php"],
        },
      },
    };
  },
});
