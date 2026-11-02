import type { RecipeSource } from "@lando/sdk/schema";
import { composerTool, phpOption, phpTool } from "../source-php.ts";
import { defaultRoutes } from "../source-web.ts";

export const source = {
  id: "lemp",
  title: "LEMP Starter",
  description: "Generic LEMP starter with nginx, PHP, and MariaDB.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["lemp", "php", "nginx", "mariadb"],
  options: { php: phpOption },
  config: {
    runtime: 4,
    services: {
      web: { type: "nginx", primary: false, backend: "appserver", webroot: ".", routes: defaultRoutes },
      appserver: {
        type: "php:{{ recipe.php }}",
        primary: true,
        framework: "none",
        via: "fpm",
        webroot: ".",
        dependsOn: ["database"],
      },
      database: { type: "mariadb" },
    },
    tooling: { composer: composerTool, php: phpTool },
  },
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring the LEMP stack up." },
  ],
} as const satisfies RecipeSource;
