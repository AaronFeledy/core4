import {
  composerToolingLines,
  renderDatabaseLines,
  renderPhpAppserverLines,
  resolvePhpStackAnswers,
} from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { JOOMLA_RECIPE_ID } from "./manifest";

const JOOMLA_DEFAULTS = {
  php: "8.3",
  database: "mariadb:11.4",
  webroot: "/app",
  composer: "2",
} as const;

const renderLandofile = (
  appName: string,
  answers: Parameters<RecipeRenderer["render"]>[0]["answers"],
): string => {
  const stack = resolvePhpStackAnswers(answers, JOOMLA_DEFAULTS);
  return [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${JOOMLA_RECIPE_ID}`,
    "services:",
    ...renderPhpAppserverLines({
      php: stack.php,
      webroot: stack.webroot,
      composer: stack.composer,
      webserver: "apache",
      allowOverride: true,
      port: 80,
      dependsOn: ["database"],
      framework: "joomla",
    }),
    ...renderDatabaseLines(stack.database),
    "tooling:",
    "  joomla:",
    "    service: appserver",
    "    description: Run the Joomla CLI inside the appserver service.",
    "    cmds:",
    "      - php cli/joomla.php",
    ...(stack.composer === false ? [] : composerToolingLines()),
    "  php:",
    "    service: appserver",
    "    description: Run the PHP CLI inside the appserver service.",
    "    cmds:",
    "      - php",
    "",
  ].join("\n");
};

export const joomlaRenderer: RecipeRenderer = {
  id: JOOMLA_RECIPE_ID,
  render: ({ appName, answers }) => new Map([[".lando.yml", renderLandofile(appName, answers)]]),
};
