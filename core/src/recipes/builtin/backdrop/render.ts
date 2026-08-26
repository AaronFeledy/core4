import {
  composerToolingLines,
  renderDatabaseLines,
  renderPhpAppserverLines,
  resolvePhpStackAnswers,
} from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { BACKDROP_RECIPE_ID } from "./manifest";

const BACKDROP_DEFAULTS = {
  php: "8.3",
  database: "mariadb:11.4",
  webroot: "/app",
  composer: "2",
} as const;

const backdropSettings = (database: string): string =>
  JSON.stringify({
    databases: {
      default: {
        default: {
          driver: "mysql",
          database,
          username: "lando",
          password: "lando",
          host: "database",
          port: 3306,
        },
      },
    },
  });

const renderLandofile = (
  appName: string,
  answers: Parameters<RecipeRenderer["render"]>[0]["answers"],
): string => {
  const stack = resolvePhpStackAnswers(answers, BACKDROP_DEFAULTS);
  return [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${BACKDROP_RECIPE_ID}`,
    "services:",
    ...renderPhpAppserverLines({
      php: stack.php,
      webroot: stack.webroot,
      composer: stack.composer,
      webserver: "apache",
      allowOverride: true,
      port: 80,
      dependsOn: ["database"],
      framework: "backdrop",
      appName,
    }),
    "    environment:",
    `      BACKDROP_SETTINGS: '${backdropSettings(appName)}'`,
    ...renderDatabaseLines(stack.database),
    "tooling:",
    "  bee:",
    "    service: appserver",
    "    description: Run Bee inside the appserver service.",
    "    cmds:",
    "      - bee",
    ...(stack.composer === false ? [] : composerToolingLines()),
    "  php:",
    "    service: appserver",
    "    description: Run the PHP CLI inside the appserver service.",
    "    cmds:",
    "      - php",
    "",
  ].join("\n");
};

export const backdropRenderer: RecipeRenderer = {
  id: BACKDROP_RECIPE_ID,
  render: ({ appName, answers }) => new Map([[".lando.yml", renderLandofile(appName, answers)]]),
};
