import type { RecipeRenderer } from "../registry.ts";
import { NODE_POSTGRES_RECIPE_ID } from "./manifest.ts";

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
    "  database:",
    "    type: postgres",
    "",
  ].join("\n");

const packageJson = (name: string): string =>
  `${JSON.stringify(
    {
      name,
      scripts: {
        start: "node server.js",
      },
    },
    null,
    2,
  )}\n`;

const serverJs = `"use strict";
const http = require("http");

const server = http.createServer(function (_req, res) {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hello from Lando\\n");
});

const port = Number(process.env.PORT || 3000);
server.listen(port, function () {
  console.log("Listening on port " + port);
});
`;

export const nodePostgresRenderer: RecipeRenderer = {
  id: NODE_POSTGRES_RECIPE_ID,
  render: ({ appName }) =>
    new Map([
      [".lando.yml", landofile(appName)],
      ["package.json", packageJson(appName)],
      ["server.js", serverJs],
    ]),
};
