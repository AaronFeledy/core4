import type { RecipeRenderer } from "../registry.ts";
import { ASTRO_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string, node: string, database: string): string => {
  const lines = [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${ASTRO_RECIPE_ID}`,
    "services:",
    "  web:",
    `    type: node:${node}`,
    "    port: 4321",
    "    environment:",
    "      ASTRO_TELEMETRY_DISABLED: '1'",
  ];
  if (database !== "none") {
    lines.push("    dependsOn:", "      - database", "  database:", `    type: ${database}`);
  }
  lines.push(
    "tooling:",
    "  astro:",
    "    service: web",
    "    description: Run the Astro CLI inside the web service.",
    "    cmds:",
    "      - npx astro",
    "  npm:",
    "    service: web",
    "    description: Run npm inside the web service.",
    "    cmds:",
    "      - npm",
    "",
  );
  return lines.join("\n");
};

export const astroRenderer: RecipeRenderer = {
  id: ASTRO_RECIPE_ID,
  render: ({ appName, answers }) => {
    const node = typeof answers.node === "string" ? answers.node : "lts";
    const database = typeof answers.database === "string" ? answers.database : "none";
    return new Map([[".lando.yml", renderLandofile(appName, node, database)]]);
  },
};
