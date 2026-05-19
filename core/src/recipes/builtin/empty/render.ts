import type { RecipeRenderer } from "../registry.ts";
import { EMPTY_RECIPE_ID } from "./manifest.ts";

const renderLandofile = (appName: string): string =>
  [`name: ${appName}`, "runtime: 4", `recipe: ${EMPTY_RECIPE_ID}`, ""].join("\n");

export const emptyRenderer: RecipeRenderer = {
  id: EMPTY_RECIPE_ID,
  render: ({ appName }) => new Map([[".lando.yml", renderLandofile(appName)]]),
};
