import type { RecipeSource } from "@lando/sdk/schema";
import { staticWebService } from "../source-web.ts";

export const source = {
  id: "eleventy",
  title: "Eleventy",
  description: "Eleventy static site with a Node-based build helper and an nginx static frontend.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["eleventy", "static", "node"],
  config: {
    runtime: 4,
    services: {
      builder: {
        type: "node:lts",
        primary: true,
        command: "npx @11ty/eleventy --serve --port 8080",
        port: 8080,
      },
      web: staticWebService("_site"),
    },
    tooling: {
      eleventy: {
        service: "builder",
        description: "Run the Eleventy CLI inside the builder service.",
        cmds: ["npx @11ty/eleventy"],
      },
      npm: { service: "builder", description: "Run npm inside the builder service.", cmds: ["npm"] },
    },
  },
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to serve the Eleventy site." },
  ],
} as const satisfies RecipeSource;
