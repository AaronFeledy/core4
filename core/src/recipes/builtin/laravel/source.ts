import type { RecipeSource } from "@lando/sdk/schema";
import { composerOption, composerTool, phpAppserver, phpOption, webrootOption } from "../source-php.ts";
import { defaultRoutes } from "../source-web.ts";

const serverEnvironment = {
  DB_HOST: "database",
  DB_PORT: "{{ json(services.database.port) }}",
  DB_DATABASE: "{{ services.database.creds.database }}",
  DB_USERNAME: "{{ services.database.creds.user }}",
  DB_PASSWORD: "{{ services.database.creds.password }}",
} as const;

export const source = {
  id: "laravel",
  title: "Laravel",
  description:
    "Laravel with PHP, MariaDB, PostgreSQL or SQLite, Redis, an optional queue worker, and an optional scheduler job.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["laravel", "php"],
  options: {
    php: phpOption,
    database: {
      type: { kind: "enum", values: ["mariadb:11.4", "postgres:16", "sqlite"] },
      default: "mariadb:11.4",
      prompt: { message: "Database" },
    },
    composer: composerOption,
    webroot: webrootOption("public"),
    worker: { type: { kind: "boolean" }, default: false, prompt: { message: "Add a queue worker service?" } },
    scheduler: {
      type: { kind: "boolean" },
      default: false,
      prompt: { message: "Run Laravel's task scheduler every minute?" },
    },
  },
  config: {
    runtime: 4,
    services: {
      appserver: {
        ...phpAppserver("laravel"),
        uploadDirs: ["storage"],
        allowOverride: true,
        port: 80,
        dependsOn: ["cache"],
        environment: { DB_CONNECTION: "sqlite" },
        routes: defaultRoutes,
      },
      cache: { type: "redis" },
      node: { type: "node:22", primary: false, endpoints: [] },
    },
    tooling: {
      artisan: {
        service: "appserver",
        description: "Run a Laravel Artisan command inside the appserver service.",
        cmds: ["php artisan"],
        wrapper: true,
      },
      composer: composerTool,
      npm: { service: "node", description: "Run npm inside the node service.", cmds: ["npm"], wrapper: true },
    },
  },
  variants: [
    {
      when: "{{ options.worker }}",
      config: {
        services: {
          appserver: { appMount: { target: "/app", includes: ["vendor"] } },
          worker: {
            type: "php:{{ recipe.php }}",
            framework: "laravel",
            via: "cli",
            command: "php artisan queue:work",
            restart: "unless-stopped",
            dependsOn: ["cache"],
            environment: { DB_CONNECTION: "sqlite" },
            appMount: { target: "/app", includes: ["vendor"] },
          },
        },
      },
    },
    {
      when: "{{ options.scheduler }}",
      config: {
        services: {
          appserver: {
            schedule: [
              {
                name: "laravel-scheduler",
                every: "* * * * *",
                run: ["php", "/app/artisan", "schedule:run"],
                user: "www-data",
              },
            ],
          },
        },
      },
    },
    {
      when: '{{ eq(options.database, "sqlite") }}',
      config: {
        services: {
          appserver: { appMount: { target: "/app" }, sqlite: { path: "database/database.sqlite" } },
        },
      },
    },
    ...(
      [
        ["mariadb:11.4", "mysql"],
        ["postgres:16", "pgsql"],
      ] as const
    ).flatMap(([database, connection]) => {
      const environment = { ...serverEnvironment, DB_CONNECTION: connection };
      return [
        {
          when: `{{ eq(options.database, "${database}") }}`,
          config: {
            services: {
              appserver: { environment, dependsOn: ["database", "cache"] },
              database: { type: "{{ recipe.database }}" },
            },
          },
        },
        {
          when: `{{ and(options.worker, eq(options.database, "${database}")) }}`,
          config: { services: { worker: { environment, dependsOn: ["database", "cache"] } } },
        },
      ];
    }),
  ],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring Laravel up." },
  ],
} as const satisfies RecipeSource;
