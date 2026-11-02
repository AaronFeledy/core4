import type { RecipeSource } from "@lando/sdk/schema";
import { composerOption, composerTool, phpAppserver, phpOption, webrootOption } from "../source-php.ts";
import { defaultRoutes } from "../source-web.ts";

export const source = {
  id: "laravel",
  title: "Laravel",
  description: "Laravel with PHP, MariaDB or PostgreSQL, Redis, and an optional queue worker.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["laravel", "php"],
  options: {
    php: phpOption,
    database: {
      type: { kind: "enum", values: ["mariadb:11.4", "postgres:16"] },
      default: "mariadb:11.4",
      prompt: { message: "Database" },
    },
    composer: composerOption,
    webroot: webrootOption("public"),
    worker: { type: { kind: "boolean" }, default: false, prompt: { message: "Add a queue worker service?" } },
  },
  config: {
    runtime: 4,
    services: {
      appserver: {
        ...phpAppserver("laravel"),
        allowOverride: true,
        port: 80,
        dependsOn: ["database", "cache"],
        routes: defaultRoutes,
      },
      database: { type: "{{ recipe.database }}" },
      cache: { type: "redis" },
      node: { type: "node:22", primary: false, endpoints: [] },
    },
    tooling: {
      artisan: {
        service: "appserver",
        description: "Run a Laravel Artisan command inside the appserver service.",
        cmds: ["php artisan"],
      },
      composer: composerTool,
      npm: { service: "node", description: "Run npm inside the node service.", cmds: ["npm"] },
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
            dependsOn: ["database", "cache"],
            appMount: { target: "/app", includes: ["vendor"] },
          },
        },
      },
    },
  ],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring Laravel up." },
  ],
} as const satisfies RecipeSource;
