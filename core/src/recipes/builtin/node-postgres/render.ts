import { renderPrimaryRouteLines } from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { NODE_POSTGRES_RECIPE_ID } from "./manifest";
import { NODE_POSTGRES_PACKAGE_JSON_TEMPLATE, NODE_POSTGRES_SERVER_JS } from "./scaffold.ts";

const landofile = (name: string): string =>
  [
    `name: ${name}`,
    "runtime: 4",
    "services:",
    "  web:",
    "    type: node:lts",
    "    ports:",
    "      - 3000:3000",
    "    environment:",
    "      NODE_ENV: development",
    "    volumes:",
    "      - ./:/app",
    "    command: node /app/server.js",
    "    dependsOn:",
    "      - database",
    ...renderPrimaryRouteLines(name),
    "  database:",
    "    type: postgres",
    "",
  ].join("\n");

const packageJson = (name: string): string =>
  NODE_POSTGRES_PACKAGE_JSON_TEMPLATE.replaceAll("{{ app.name }}", name);

export const nodePostgresRenderer: RecipeRenderer = {
  id: NODE_POSTGRES_RECIPE_ID,
  render: ({ appName }) =>
    new Map([
      [".lando.yml", landofile(appName)],
      ["package.json", packageJson(appName)],
      ["server.js", NODE_POSTGRES_SERVER_JS],
    ]),
};
