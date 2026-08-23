import {
  composerToolingLines,
  renderDatabaseLines,
  renderPhpAppserverLines,
  resolvePhpStackAnswers,
} from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { LARAVEL_RECIPE_ID } from "./manifest";

const LARAVEL_DEFAULTS = {
  php: "8.3",
  database: "mariadb:11.4",
  webroot: "/app/public",
  composer: "2",
} as const;

const renderLandofile = (
  appName: string,
  answers: Parameters<RecipeRenderer["render"]>[0]["answers"],
): string => {
  const stack = resolvePhpStackAnswers(answers, LARAVEL_DEFAULTS);
  const worker = answers.worker === true || answers.worker === "true";
  const lines = [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${LARAVEL_RECIPE_ID}`,
    "services:",
    ...renderPhpAppserverLines({
      php: stack.php,
      webroot: stack.webroot,
      composer: stack.composer,
      webserver: "apache",
      allowOverride: true,
      port: 80,
      dependsOn: ["database", "cache"],
      framework: "laravel",
    }),
    ...renderDatabaseLines(stack.database),
    "  cache:",
    "    type: redis",
  ];
  if (worker) {
    lines.push(
      "  worker:",
      `    type: php:${stack.php}`,
      "    framework: laravel",
      "    via: cli",
      "    command: php artisan queue:work",
      "    dependsOn:",
      "      - database",
      "      - cache",
    );
  }
  lines.push(
    "tooling:",
    "  artisan:",
    "    service: appserver",
    "    description: Run a Laravel Artisan command inside the appserver service.",
    "    cmds:",
    "      - php artisan",
    ...(stack.composer === false ? [] : composerToolingLines()),
    "  npm:",
    "    service: appserver",
    "    description: Run npm inside the appserver service.",
    "    cmds:",
    "      - npm",
    "",
  );
  return lines.join("\n");
};

export const laravelRenderer: RecipeRenderer = {
  id: LARAVEL_RECIPE_ID,
  render: ({ appName, answers }) => new Map([[".lando.yml", renderLandofile(appName, answers)]]),
};
