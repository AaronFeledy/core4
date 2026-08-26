import {
  composerToolingLines,
  renderDatabaseLines,
  renderPhpAppserverLines,
  resolvePhpStackAnswers,
} from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { LAMP_RECIPE_ID } from "./manifest";

const LAMP_DEFAULTS = {
  php: "8.3",
  database: "mariadb:11.4",
  webroot: "/app",
  composer: "2",
} as const;

const renderLandofile = (
  appName: string,
  answers: Parameters<RecipeRenderer["render"]>[0]["answers"],
): string => {
  const stack = resolvePhpStackAnswers(answers, LAMP_DEFAULTS);
  return [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${LAMP_RECIPE_ID}`,
    "services:",
    ...renderPhpAppserverLines({
      php: stack.php,
      webroot: stack.webroot,
      composer: stack.composer,
      webserver: "apache",
      port: 80,
      dependsOn: ["database"],
      framework: "none",
      appName,
    }),
    ...renderDatabaseLines(stack.database),
    "tooling:",
    ...(stack.composer === false ? [] : composerToolingLines()),
    "  php:",
    "    service: appserver",
    "    description: Run the PHP CLI inside the appserver service.",
    "    cmds:",
    "      - php",
    "",
  ].join("\n");
};

export const lampRenderer: RecipeRenderer = {
  id: LAMP_RECIPE_ID,
  render: ({ appName, answers }) => new Map([[".lando.yml", renderLandofile(appName, answers)]]),
};
