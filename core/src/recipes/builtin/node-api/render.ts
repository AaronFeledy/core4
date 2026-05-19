import type { RecipeRenderer } from "../registry.ts";
import { NODE_API_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string, node: string, framework: string, database: string): string => {
  const lines = [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${NODE_API_RECIPE_ID}`,
    "services:",
    "  api:",
    `    type: node:${node}`,
    "    port: 3000",
    "    environment:",
    `      API_FRAMEWORK: ${framework}`,
  ];
  if (database !== "none") {
    lines.push("    dependsOn:", "      - database", "  database:", `    type: ${database}`);
  }
  lines.push(
    "tooling:",
    "  npm:",
    "    service: api",
    "    description: Run npm inside the api service.",
    "    cmds:",
    "      - npm",
    "  node:",
    "    service: api",
    "    description: Run Node inside the api service.",
    "    cmds:",
    "      - node",
    "",
  );
  return lines.join("\n");
};

export const nodeApiRenderer: RecipeRenderer = {
  id: NODE_API_RECIPE_ID,
  render: ({ appName, answers }) => {
    const node = typeof answers.node === "string" ? answers.node : "lts";
    const framework = typeof answers.framework === "string" ? answers.framework : "express";
    const database = typeof answers.database === "string" ? answers.database : "postgres";
    return new Map([[".lando.yml", renderLandofile(appName, node, framework, database)]]);
  },
};
