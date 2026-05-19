import type { RecipeRenderer } from "../registry.ts";
import { SYMFONY_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string, php: string, database: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${SYMFONY_RECIPE_ID}`,
    "services:",
    "  appserver:",
    `    type: php:${php}`,
    "    framework: symfony",
    "    port: 80",
    "    dependsOn:",
    "      - database",
    "      - cache",
    "  database:",
    `    type: ${database}`,
    "  cache:",
    "    type: redis",
    "tooling:",
    "  console:",
    "    service: appserver",
    "    description: Run the Symfony console inside the appserver service.",
    "    cmds:",
    "      - php bin/console",
    "  composer:",
    "    service: appserver",
    "    description: Run Composer inside the appserver service.",
    "    cmds:",
    "      - composer",
    "",
  ].join("\n");

export const symfonyRenderer: RecipeRenderer = {
  id: SYMFONY_RECIPE_ID,
  render: ({ appName, answers }) => {
    const php = typeof answers.php === "string" ? answers.php : "8.3";
    const database = typeof answers.database === "string" ? answers.database : "postgres";
    return new Map([[".lando.yml", renderLandofile(appName, php, database)]]);
  },
};
