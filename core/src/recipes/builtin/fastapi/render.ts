import { renderPrimaryRouteLines } from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { FASTAPI_RECIPE_ID } from "./manifest";

const renderLandofile = (appName: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${FASTAPI_RECIPE_ID}`,
    "services:",
    "  web:",
    "    type: python:3.12",
    "    framework: fastapi",
    "    port: 8000",
    "    dependsOn:",
    "      - database",
    "      - cache",
    ...renderPrimaryRouteLines(appName),
    "  database:",
    "    type: postgres",
    "  cache:",
    "    type: redis",
    "tooling:",
    "  uvicorn:",
    "    service: web",
    "    description: Run uvicorn inside the web service.",
    "    cmds:",
    "      - uvicorn",
    "  pip:",
    "    service: web",
    "    description: Run pip inside the web service.",
    "    cmds:",
    "      - pip",
    "",
  ].join("\n");

export const fastapiRenderer: RecipeRenderer = {
  id: FASTAPI_RECIPE_ID,
  render: ({ appName }) => new Map([[".lando.yml", renderLandofile(appName)]]),
};
