import type { RecipeRenderer } from "../registry.ts";
import { ELEVENTY_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${ELEVENTY_RECIPE_ID}`,
    "services:",
    "  builder:",
    "    type: node:lts",
    "    command: npx @11ty/eleventy --serve --port 8080",
    "    port: 8080",
    "  web:",
    "    type: static:nginx",
    "    appMount:",
    "      target: /app",
    "tooling:",
    "  eleventy:",
    "    service: builder",
    "    description: Run the Eleventy CLI inside the builder service.",
    "    cmds:",
    "      - npx @11ty/eleventy",
    "  npm:",
    "    service: builder",
    "    description: Run npm inside the builder service.",
    "    cmds:",
    "      - npm",
    "",
  ].join("\n");

export const eleventyRenderer: RecipeRenderer = {
  id: ELEVENTY_RECIPE_ID,
  render: ({ appName }) => new Map([[".lando.yml", renderLandofile(appName)]]),
};
