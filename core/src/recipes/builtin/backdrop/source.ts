import type { RecipeSource } from "@lando/sdk/schema";
import { backdropSettings } from "./settings.ts";

export const source = {
  id: "backdrop",
  title: "Backdrop",
  description: "Backdrop CMS with Apache PHP and MariaDB.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["backdrop", "php", "apache", "mariadb"],
  extends: "lamp",
  config: {
    services: {
      appserver: {
        framework: "backdrop",
        allowOverride: true,
        environment: { BACKDROP_SETTINGS: backdropSettings("{{ app.name }}") },
      },
    },
    tooling: {
      bee: { service: "appserver", description: "Run Bee inside the appserver service.", cmds: ["bee"] },
    },
  },
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring Backdrop up." },
  ],
} as const satisfies RecipeSource;
