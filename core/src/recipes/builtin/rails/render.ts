import type { RecipeRenderer } from "../registry.ts";
import { RAILS_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${RAILS_RECIPE_ID}`,
    "services:",
    "  web:",
    "    type: ruby:3.3",
    "    framework: rails",
    "    port: 3000",
    "    dependsOn:",
    "      - database",
    "      - cache",
    "  database:",
    "    type: postgres",
    "  cache:",
    "    type: redis",
    "tooling:",
    "  rails:",
    "    service: web",
    "    description: Run the Rails CLI inside the web service.",
    "    cmds:",
    "      - rails",
    "  bundle:",
    "    service: web",
    "    description: Run Bundler inside the web service.",
    "    cmds:",
    "      - bundle",
    "",
  ].join("\n");

export const railsRenderer: RecipeRenderer = {
  id: RAILS_RECIPE_ID,
  render: ({ appName }) => new Map([[".lando.yml", renderLandofile(appName)]]),
};
