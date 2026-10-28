import type { RecipeSource } from "@lando/sdk/schema";
import { composerTool, phpOption } from "../source-php.ts";
import { defaultRoutes, redisOption } from "../source-web.ts";

export const source = {
  id: "wordpress",
  title: "WordPress",
  description: "WordPress with PHP, MariaDB, and an optional Redis cache.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["wordpress", "php", "mariadb"],
  options: { php: phpOption, redis: redisOption },
  config: {
    runtime: 4,
    services: {
      appserver: {
        type: "php:{{ recipe.php }}",
        primary: true,
        framework: "wordpress",
        port: 80,
        dependsOn: ["database"],
        routes: defaultRoutes,
      },
      database: { type: "mariadb" },
    },
    tooling: {
      wp: { service: "appserver", description: "Run WP-CLI inside the appserver service.", cmds: ["wp"] },
      composer: composerTool,
    },
  },
  variants: [
    {
      when: "{{ options.redis }}",
      config: { services: { appserver: { dependsOn: ["cache"] }, cache: { type: "redis" } } },
    },
  ],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring WordPress up." },
  ],
} as const satisfies RecipeSource;
