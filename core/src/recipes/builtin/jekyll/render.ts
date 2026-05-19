import type { RecipeRenderer } from "../registry.ts";
import { JEKYLL_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${JEKYLL_RECIPE_ID}`,
    "services:",
    "  builder:",
    "    type: ruby:3.3",
    "    framework: none",
    "    command: bundle exec jekyll serve --host 0.0.0.0 --port 4000",
    "    port: 4000",
    "  web:",
    "    type: static:nginx",
    "    appMount:",
    "      target: /app",
    "tooling:",
    "  jekyll:",
    "    service: builder",
    "    description: Run the Jekyll CLI inside the builder service.",
    "    cmds:",
    "      - bundle exec jekyll",
    "  bundle:",
    "    service: builder",
    "    description: Run Bundler inside the builder service.",
    "    cmds:",
    "      - bundle",
    "",
  ].join("\n");

export const jekyllRenderer: RecipeRenderer = {
  id: JEKYLL_RECIPE_ID,
  render: ({ appName }) => new Map([[".lando.yml", renderLandofile(appName)]]),
};
