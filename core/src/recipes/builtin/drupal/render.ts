import type { RecipeRenderer } from "../registry.ts";
import { DRUPAL_RECIPE_ID } from "./manifest.ts";

const DRUPAL_SCAFFOLD_COMMAND = [
  "set -eu",
  'test ! -e /app/composer.json || { echo "Drupal is already scaffolded at /app." >&2; exit 1; }',
  "destination=$(mktemp -d /tmp/lando-drupal-scaffold.XXXXXX)",
  "trap 'rm -rf \"$destination\"' EXIT",
  'composer create-project drupal/recommended-project "$destination"',
  'composer require --working-dir="$destination" drush/drush',
  'cp -R "$destination"/. /app/',
].join("; ");

const renderLandofile = (appName: string, php: string, database: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${DRUPAL_RECIPE_ID}`,
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
    "      - vendor/bin/drush",
    "  composer:",
    "    service: appserver",
    "    description: Run Composer inside the appserver service.",
    "    cmds:",
    "      - composer",
    "  drupal-scaffold:",
    "    service: appserver",
    "    description: Scaffold Drupal 11 into the mounted app root.",
    `    cmd: ${JSON.stringify(DRUPAL_SCAFFOLD_COMMAND)}`,
    "",
  ].join("\n");

export const drupalRenderer: RecipeRenderer = {
  id: DRUPAL_RECIPE_ID,
  render: ({ appName, answers }) => {
    const php = typeof answers.php === "string" ? answers.php : "8.3";
    const database = typeof answers.database === "string" ? answers.database : "mariadb";
    return new Map([[".lando.yml", renderLandofile(appName, php, database)]]);
  },
};
