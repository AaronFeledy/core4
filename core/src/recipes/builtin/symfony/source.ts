import type { RecipeSource } from "@lando/sdk/schema";
import { composerOption, composerTool, phpAppserver, phpOption, webrootOption } from "../source-php.ts";
import { defaultRoutes, postgresUrl } from "../source-web.ts";

export const source = {
  id: "symfony",
  title: "Symfony",
  description: "Symfony with PHP, PostgreSQL or MariaDB, and Redis.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["symfony", "php"],
  options: {
    php: phpOption,
    database: {
      type: { kind: "enum", values: ["postgres:16", "mariadb:11.4"] },
      default: "postgres:16",
      prompt: { message: "Database" },
    },
    composer: composerOption,
    webroot: webrootOption("public"),
  },
  config: {
    runtime: 4,
    services: {
      appserver: {
        ...phpAppserver("symfony"),
        allowOverride: true,
        port: 80,
        environment: {
          DATABASE_URL: `${postgresUrl}?serverVersion=16&charset=utf8`,
          REDIS_URL: "redis://cache:6379",
        },
        dependsOn: ["database", "cache"],
        routes: defaultRoutes,
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
      composer: composerTool,
    },
  },
  variants: [
    {
      when: '{{ eq(options.database, "mariadb:11.4") }}',
      config: {
        services: {
          appserver: {
            environment: {
              DATABASE_URL:
                "mysql://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database:{{ services.database.port }}/{{ url.encodeComponent(services.database.creds.database) }}?serverVersion=11.4.0-MariaDB&charset=utf8mb4",
            },
          },
        },
      },
    },
  ],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring Symfony up." },
  ],
} as const satisfies RecipeSource;
