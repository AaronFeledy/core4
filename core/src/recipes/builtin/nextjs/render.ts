import type { RecipeRenderer } from "../registry.ts";
import { NEXTJS_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string, node: string, database: string, auth: string): string => {
  const lines = [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${NEXTJS_RECIPE_ID}`,
    "services:",
    "  web:",
    `    type: node:${node}`,
    "    port: 3000",
    "    environment:",
    `      NEXTAUTH_PROVIDER: ${auth}`,
  ];
  if (database !== "none") {
    lines.push("    dependsOn:", "      - database", "  database:", `    type: ${database}`);
  }
  lines.push(
    "tooling:",
    "  next:",
    "    service: web",
    "    description: Run the Next.js CLI inside the web service.",
    "    cmds:",
    "      - npx next",
    "  npm:",
    "    service: web",
    "    description: Run npm inside the web service.",
    "    cmds:",
    "      - npm",
    "",
  );
  return lines.join("\n");
};

export const nextjsRenderer: RecipeRenderer = {
  id: NEXTJS_RECIPE_ID,
  render: ({ appName, answers }) => {
    const node = typeof answers.node === "string" ? answers.node : "lts";
    const database = typeof answers.database === "string" ? answers.database : "postgres";
    const auth = typeof answers.auth === "string" ? answers.auth : "none";
    return new Map([[".lando.yml", renderLandofile(appName, node, database, auth)]]);
  },
};
