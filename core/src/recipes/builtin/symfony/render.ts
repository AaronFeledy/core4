import {
  composerToolingLines,
  renderDatabaseLines,
  renderPhpAppserverLines,
  resolvePhpStackAnswers,
} from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { SYMFONY_RECIPE_ID } from "./manifest";

const SYMFONY_DEFAULTS = {
  php: "8.3",
  database: "postgres:16",
  webroot: "/app/public",
  composer: "2",
} as const;

const renderLandofile = (
  appName: string,
  answers: Parameters<RecipeRenderer["render"]>[0]["answers"],
): string => {
  const stack = resolvePhpStackAnswers(answers, SYMFONY_DEFAULTS);
  return [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${SYMFONY_RECIPE_ID}`,
    "services:",
    ...renderPhpAppserverLines({
      php: stack.php,
      webroot: stack.webroot,
      composer: stack.composer,
      webserver: "apache",
      allowOverride: true,
      port: 80,
      dependsOn: ["database", "cache"],
      framework: "symfony",
      appName,
    }),
    ...renderDatabaseLines(stack.database),
    "  cache:",
    "    type: redis",
    "tooling:",
    "  console:",
    "    service: appserver",
    "    description: Run the Symfony console inside the appserver service.",
    "    cmds:",
    "      - php bin/console",
    ...(stack.composer === false ? [] : composerToolingLines()),
    "",
  ].join("\n");
};

export const symfonyRenderer: RecipeRenderer = {
  id: SYMFONY_RECIPE_ID,
  render: ({ appName, answers }) => new Map([[".lando.yml", renderLandofile(appName, answers)]]),
};
