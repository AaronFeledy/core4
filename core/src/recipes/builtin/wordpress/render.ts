import type { RecipeRenderer } from "../registry.ts";
import { WORDPRESS_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string, php: string, redis: boolean): string => {
  const lines = [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${WORDPRESS_RECIPE_ID}`,
    "services:",
    "  appserver:",
    `    type: php:${php}`,
    "    framework: wordpress",
    "    port: 80",
    "    dependsOn:",
    "      - database",
  ];
  if (redis) lines.push("      - cache");
  lines.push("  database:", "    type: mariadb");
  if (redis) lines.push("  cache:", "    type: redis");
  lines.push("tooling:");
  lines.push("  wp:");
  lines.push("    service: appserver");
  lines.push("    description: Run WP-CLI inside the appserver service.");
  lines.push("    cmds:");
  lines.push("      - wp");
  lines.push("  composer:");
  lines.push("    service: appserver");
  lines.push("    description: Run Composer inside the appserver service.");
  lines.push("    cmds:");
  lines.push("      - composer");
  lines.push("");
  return lines.join("\n");
};

export const wordpressRenderer: RecipeRenderer = {
  id: WORDPRESS_RECIPE_ID,
  render: ({ appName, answers }) => {
    const php = typeof answers.php === "string" ? answers.php : "8.3";
    const redis = answers.redis === true || answers.redis === "true";
    return new Map([[".lando.yml", renderLandofile(appName, php, redis)]]);
  },
};
