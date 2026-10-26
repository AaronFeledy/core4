import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { symfonyProducer, symfonySnapshot } from "./snapshot.ts";

export const symfonyDecomposer: RecipeDecomposerFactory = makeOptionBearingDecomposer({
  producer: symfonyProducer,
  displayName: "Symfony",
  optionTypes: symfonySnapshot.optionTypes,
  fragment: (input) => {
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
          environment: {
            DATABASE_URL:
              input.options.database === "mariadb:11.4"
                ? "mysql://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database:{{ services.database.port }}/{{ url.encodeComponent(services.database.creds.database) }}?serverVersion=11.4.0-MariaDB&charset=utf8mb4"
                : "postgresql://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database:{{ services.database.port }}/{{ url.encodeComponent(services.database.creds.database) }}?serverVersion=16&charset=utf8",
            REDIS_URL: "redis://cache:6379",
          },
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
