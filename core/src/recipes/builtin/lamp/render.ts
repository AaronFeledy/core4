import type { RecipeRenderer } from "../registry.ts";
import { LAMP_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string, php: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${LAMP_RECIPE_ID}`,
    "services:",
    "  appserver:",
    `    type: php:${php}`,
    "    framework: none",
    "    port: 80",
    "    dependsOn:",
    "      - database",
    "  database:",
    "    type: mariadb",
    "tooling:",
    "  composer:",
    "    service: appserver",
    "    description: Run Composer inside the appserver service.",
    "    cmds:",
    "      - composer",
    "  php:",
    "    service: appserver",
    "    description: Run the PHP CLI inside the appserver service.",
    "    cmds:",
    "      - php",
    "",
  ].join("\n");

export const lampRenderer: RecipeRenderer = {
  id: LAMP_RECIPE_ID,
  render: ({ appName, answers }) => {
    const php = typeof answers.php === "string" ? answers.php : "8.3";
    return new Map([[".lando.yml", renderLandofile(appName, php)]]);
  },
};
