import type { RecipeSource } from "@lando/sdk/schema";
import {
  composerOption,
  composerTool,
  phpAppserver,
  phpOption,
  phpTool,
  webrootOption,
} from "../source-php.ts";
import { defaultRoutes } from "../source-web.ts";

export const source = {
  id: "lamp",
  title: "LAMP Starter",
  description: "Generic LAMP starter with Apache, PHP, and MariaDB or MySQL.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["lamp", "php", "apache", "mariadb"],
  options: {
    php: phpOption,
    database: {
      type: { kind: "enum", values: ["mariadb:11.4", "mysql:8.0"] },
      default: "mariadb:11.4",
      prompt: { message: "Database" },
    },
    composer: { ...composerOption, type: { kind: "enum", values: ["2", "2.7.7", false] } },
    webroot: webrootOption("."),
  },
  config: {
    runtime: 4,
    services: {
      appserver: { ...phpAppserver("none"), port: 80, routes: defaultRoutes },
      database: { type: "{{ recipe.database }}" },
    },
    tooling: { php: phpTool },
  },
  variants: [{ when: "{{ ne(options.composer, false) }}", config: { tooling: { composer: composerTool } } }],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring the LAMP stack up." },
  ],
} as const satisfies RecipeSource;
