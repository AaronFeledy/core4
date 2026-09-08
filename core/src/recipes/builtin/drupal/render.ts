import {
  composerToolingLines,
  renderDatabaseLines,
  renderNginxEdgeLines,
  renderPhpAppserverLines,
  resolvePhpStackAnswers,
} from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { DRUPAL_RECIPE_ID } from "./manifest";
import { DRUPAL_SCAFFOLD_COMMAND, drupalScaffoldCommand } from "./scaffold-command.ts";

const DRUPAL_DEFAULTS = {
  php: "8.3",
  database: "mariadb:11.4",
  webroot: "/app/web",
  composer: "2",
} as const;

export { DRUPAL_SCAFFOLD_COMMAND, drupalScaffoldCommand };

const renderLandofile = (
  appName: string,
  answers: Parameters<RecipeRenderer["render"]>[0]["answers"],
): string => {
  const stack = resolvePhpStackAnswers(answers, DRUPAL_DEFAULTS);
  const major = typeof answers.drupal === "string" ? answers.drupal : "11";
  const scaffold = drupalScaffoldCommand(major);
  return [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${DRUPAL_RECIPE_ID}`,
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
    ...renderDatabaseLines(stack.database),
    "tooling:",
    "  drush:",
    "    service: appserver",
    "    description: Run Drush inside the appserver service.",
    "    cmds:",
    "      - vendor/bin/drush",
    ...(stack.composer === false ? [] : composerToolingLines()),
    "  drupal-scaffold:",
    "    service: appserver",
    "    description: Scaffold Drupal and project-local Drush into the mounted app root.",
    "    arguments: false",
    `    cmd: ${JSON.stringify(scaffold)}`,
    "",
  ].join("\n");
};

export const drupalRenderer: RecipeRenderer = {
  id: DRUPAL_RECIPE_ID,
  render: ({ appName, answers }) => new Map([[".lando.yml", renderLandofile(appName, answers)]]),
};
