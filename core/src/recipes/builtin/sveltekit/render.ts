import type { RecipeRenderer } from "../registry.ts";
import { SVELTEKIT_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string, node: string, adapter: string, database: string): string => {
  const lines = [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${SVELTEKIT_RECIPE_ID}`,
    "services:",
    "  web:",
    `    type: node:${node}`,
    "    port: 5173",
    "    environment:",
    `      SVELTEKIT_ADAPTER: ${adapter}`,
  ];
  if (database !== "none") {
    lines.push("    dependsOn:", "      - database", "  database:", `    type: ${database}`);
  }
  lines.push(
    "tooling:",
    "  svelte:",
    "    service: web",
    "    description: Run the Svelte CLI inside the web service.",
    "    cmds:",
    "      - npx svelte-kit",
    "  npm:",
    "    service: web",
    "    description: Run npm inside the web service.",
    "    cmds:",
    "      - npm",
    "",
  );
  return lines.join("\n");
};

export const sveltekitRenderer: RecipeRenderer = {
  id: SVELTEKIT_RECIPE_ID,
  render: ({ appName, answers }) => {
    const node = typeof answers.node === "string" ? answers.node : "lts";
    const adapter = typeof answers.adapter === "string" ? answers.adapter : "node";
    const database = typeof answers.database === "string" ? answers.database : "none";
    return new Map([[".lando.yml", renderLandofile(appName, node, adapter, database)]]);
  },
};
