import {
  composerToolingLines,
  renderDatabaseLines,
  renderNginxEdgeLines,
  renderPhpAppserverLines,
  resolvePhpStackAnswers,
} from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { DRUPAL_CMS_SCAFFOLD_COMMAND, drupalCmsInstallCommand } from "./commands.ts";
import { DRUPAL_CMS_RECIPE_ID } from "./manifest";

const DRUPAL_CMS_DEFAULTS = {
  php: "8.3",
  database: "mariadb:11.4",
  webroot: "/app/web",
  composer: "2",
} as const;

const renderLandofile = (
  appName: string,
  answers: Parameters<RecipeRenderer["render"]>[0]["answers"],
): string => {
  const stack = resolvePhpStackAnswers(answers, DRUPAL_CMS_DEFAULTS);
  const dbDriver = stack.database.startsWith("postgres") ? "pgsql" : "mysql";
  const dbName = appName;

  return [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${DRUPAL_CMS_RECIPE_ID}`,
    "services:",
    ...renderPhpAppserverLines({
      php: stack.php,
      webroot: stack.webroot,
      composer: stack.composer,
      webserver: stack.webserver,
      allowOverride: true,
      port: 80,
      dependsOn: ["database"],
      framework: "drupal",
      appName,
    }),
    ...(stack.webserver === "nginx" ? renderNginxEdgeLines(stack.webroot, appName) : []),
    ...renderDatabaseLines(stack.database, { databaseName: dbName }),
    "tooling:",
    "  drush:",
    "    service: appserver",
    "    description: Run Drush inside the appserver service.",
    "    cmds:",
    "      - vendor/bin/drush",
    ...(stack.composer === false ? [] : composerToolingLines()),
    "  drupal-cms-scaffold:",
    "    service: appserver",
    "    description: Scaffold Drupal CMS 2 and project-local Drush into the mounted app root.",
    "    arguments: false",
    `    cmd: ${JSON.stringify(DRUPAL_CMS_SCAFFOLD_COMMAND)}`,
    "  drupal-cms-install:",
    "    service: appserver",
    "    description: Install Drupal CMS 2 using the drupal_cms_starter recipe.",
    "    arguments: false",
    `    cmd: ${drupalCmsInstallCommand(dbDriver, dbName)}`,
    "",
  ].join("\n");
};

export const drupalCmsRenderer: RecipeRenderer = {
  id: DRUPAL_CMS_RECIPE_ID,
  render: ({ appName, answers }) => new Map([[".lando.yml", renderLandofile(appName, answers)]]),
};
