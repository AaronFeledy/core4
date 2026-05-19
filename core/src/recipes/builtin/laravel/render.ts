import type { RecipeRenderer } from "../registry.ts";
import { LARAVEL_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string, php: string, database: string, worker: boolean): string => {
  const lines = [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${LARAVEL_RECIPE_ID}`,
    "services:",
    "  appserver:",
    `    type: php:${php}`,
    "    framework: laravel",
    "    port: 80",
    "    dependsOn:",
    "      - database",
    "      - cache",
    "  database:",
    `    type: ${database}`,
    "  cache:",
    "    type: redis",
  ];
  if (worker) {
    lines.push(
      "  worker:",
      `    type: php:${php}`,
      "    framework: laravel",
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
    "  composer:",
    "    service: appserver",
    "    description: Run Composer inside the appserver service.",
    "    cmds:",
    "      - composer",
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
  render: ({ appName, answers }) => {
    const php = typeof answers.php === "string" ? answers.php : "8.3";
    const database = typeof answers.database === "string" ? answers.database : "mariadb";
    const worker = answers.worker === true || answers.worker === "true";
    return new Map([[".lando.yml", renderLandofile(appName, php, database, worker)]]);
  },
};
