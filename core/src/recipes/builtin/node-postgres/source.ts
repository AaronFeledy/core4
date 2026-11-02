import type { RecipeSource } from "@lando/sdk/schema";
import { defaultRoutes } from "../source-web.ts";

export const source = {
  id: "node-postgres",
  title: "Node + Postgres",
  description: "Minimal Node.js + Postgres scaffold.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["node", "postgres"],
  config: {
    runtime: 4,
    services: {
      web: {
        type: "node:lts",
        ports: ["3000:3000"],
        environment: { NODE_ENV: "development" },
        volumes: ["./:/app"],
        command: ["node", "/app/server.js"],
        dependsOn: ["database"],
        routes: defaultRoutes,
      },
      database: { type: "postgres" },
    },
  },
  files: [
    { src: "templates/package.json.tmpl", dest: "package.json", template: true },
    { src: "assets/server.js", dest: "server.js", template: false },
  ],
  postInit: [{ type: "message", text: "Run 'lando start' inside the new app directory to bring it up." }],
} as const satisfies RecipeSource;
