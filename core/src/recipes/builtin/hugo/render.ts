import type { RecipeRenderer } from "../registry.ts";
import { HUGO_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${HUGO_RECIPE_ID}`,
    "services:",
    "  builder:",
    "    type: node:lts",
    "    command: npx hugo server --bind 0.0.0.0 --port 1313",
    "    port: 1313",
    "  web:",
    "    type: static:nginx",
    "    appMount:",
    "      target: /app",
    "tooling:",
    "  hugo:",
    "    service: builder",
    "    description: Run the Hugo CLI inside the builder service.",
    "    cmds:",
    "      - npx hugo",
    "  npm:",
    "    service: builder",
    "    description: Run npm inside the builder service.",
    "    cmds:",
    "      - npm",
    "",
  ].join("\n");

export const hugoRenderer: RecipeRenderer = {
  id: HUGO_RECIPE_ID,
  render: ({ appName }) => new Map([[".lando.yml", renderLandofile(appName)]]),
};
