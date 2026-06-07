import type { RecipeRenderer } from "../registry.ts";
import { DRUPAL_CMS_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string, php: string, database: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${DRUPAL_CMS_RECIPE_ID}`,
    "services:",
    "  appserver:",
    `    type: php:${php}`,
    "    framework: drupal",
    "    port: 80",
    "    dependsOn:",
    "      - database",
    "  database:",
    `    type: ${database}`,
    "tooling:",
    "  drush:",
    "    service: appserver",
    "    description: Run Drush inside the appserver service.",
    "    cmds:",
    "      - drush",
    "  composer:",
    "    service: appserver",
    "    description: Run Composer inside the appserver service.",
    "    cmds:",
    "      - composer",
    "",
  ].join("\n");

export const drupalCmsRenderer: RecipeRenderer = {
  id: DRUPAL_CMS_RECIPE_ID,
  render: ({ appName, answers }) => {
    const php = typeof answers.php === "string" ? answers.php : "8.3";
    const database = typeof answers.database === "string" ? answers.database : "mariadb";
    return new Map([[".lando.yml", renderLandofile(appName, php, database)]]);
  },
};
