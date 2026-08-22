import type { RecipeRenderer } from "../registry";
import { MEAN_RECIPE_ID } from "./manifest";

const renderLandofile = (appName: string, node: string, redis: boolean): string => {
  const lines = [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${MEAN_RECIPE_ID}`,
    "services:",
    "  api:",
    `    type: node:${node}`,
    "    port: 3000",
    "    environment:",
    "      NODE_ENV: development",
    "      PORT: 3000",
    `      MONGO_URL: mongodb://lando:lando@database:27017/${appName}?authSource=admin`,
  ];
  if (redis) lines.push("      REDIS_URL: redis://cache:6379");
  lines.push("    dependsOn:", "      - database");
  if (redis) lines.push("      - cache");
  lines.push("  database:", "    type: mongodb");
  if (redis) lines.push("  cache:", "    type: redis");
  lines.push(
    "tooling:",
    "  npm:",
    "    service: api",
    "    description: Run npm inside the api service.",
    "    cmds:",
    "      - npm",
    "  node:",
    "    service: api",
    "    description: Run Node inside the api service.",
    "    cmds:",
    "      - node",
    "",
  );
  return lines.join("\n");
};

const renderPackageJson = (appName: string): string =>
  `${JSON.stringify(
    {
      name: appName,
      private: true,
      scripts: {
        start: "node server.js",
      },
      dependencies: {
        express: "^4.21.2",
      },
    },
    null,
    2,
  )}\n`;

const serverJs = `"use strict";
const express = require("express");

const app = express();
const port = Number(process.env.PORT || 3000);

app.get("/", function (_req, res) {
  res.type("text/plain").send("Hello from Lando\\n");
});

app.listen(port, function () {
  console.log("Listening on port " + port);
});
`;

export const meanRenderer: RecipeRenderer = {
  id: MEAN_RECIPE_ID,
  render: ({ appName, answers }) => {
    const node = typeof answers.node === "string" ? answers.node : "lts";
    const redis = answers.redis === true || answers.redis === "true";
    return new Map([
      [".lando.yml", renderLandofile(appName, node, redis)],
      ["package.json", renderPackageJson(appName)],
      ["server.js", serverJs],
    ]);
  },
};
