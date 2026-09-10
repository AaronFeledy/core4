import type { RecipeRenderer } from "../registry";
import { TOOLBOX_IMAGE } from "./image";
import { TOOLBOX_RECIPE_ID } from "./manifest";

export { TOOLBOX_IMAGE } from "./image";

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
