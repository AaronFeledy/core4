import type { RecipeSource } from "@lando/sdk/schema";

export const source = {
  id: "joomla",
  title: "Joomla",
  description: "Joomla with Apache PHP and MariaDB.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["joomla", "php", "apache", "mariadb"],
  extends: "lamp",
  config: {
    services: { appserver: { framework: "joomla", allowOverride: true } },
    tooling: {
      joomla: {
        service: "appserver",
        description: "Run the Joomla CLI inside the appserver service.",
        cmds: ["php cli/joomla.php"],
      },
    },
  },
  postInit: [{ type: "message", text: "Run 'lando start' inside the new app directory to bring Joomla up." }],
} as const satisfies RecipeSource;
