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
        command: [":node-install-run", "start"],
        port: 8080,
      },
      web: staticWebService("_site"),
    },
    tooling: {
      eleventy: {
        service: "builder",
        description: "Run the Eleventy CLI inside the builder service.",
        cmd: [":node-local", "eleventy"],
        wrapper: true,
      },
    },
  },
  files: [{ src: "templates/package.json.tmpl", dest: "package.json", template: true }],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to serve the Eleventy site." },
  ],
} as const satisfies RecipeSource;
