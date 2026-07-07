import type { RecipeRenderer } from "../registry.ts";
import { TOOLBOX_RECIPE_ID } from "./manifest.ts";

/**
 * Version-pinned general-purpose CLI image for one-shot tool execution.
 * Pinned to an exact Debian point release; never a floating tag.
 */
export const TOOLBOX_IMAGE = "debian:12.11-slim";

const renderLandofile = (appName: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${TOOLBOX_RECIPE_ID}`,
    "services:",
    "  toolbox:",
    "    type: lando",
    "    primary: true",
    `    image: ${TOOLBOX_IMAGE}`,
    "    command: sleep infinity",
    "",
  ].join("\n");

export const toolboxRenderer: RecipeRenderer = {
  id: TOOLBOX_RECIPE_ID,
  render: ({ appName }) => new Map([[".lando.yml", renderLandofile(appName)]]),
};
