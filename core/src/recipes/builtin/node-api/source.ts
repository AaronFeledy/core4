import type { RecipeSource } from "@lando/sdk/schema";
import { defaultRoutes, nodeOption, postgresUrl } from "../source-web.ts";

export const source = {
  id: "node-api",
  title: "Node API",
  description:
    "Node API with an Express, Fastify, or Hono framework picker and an optional Postgres database.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["node", "api"],
  options: {
    node: nodeOption,
    framework: {
      type: { kind: "enum", values: ["express", "fastify", "hono"] },
      default: "express",
      prompt: { message: "API framework" },
    },
    database: {
      type: { kind: "enum", values: ["postgres", "none"] },
      default: "postgres",
      prompt: { message: "Database" },
    },
  },
  config: {
    runtime: 4,
    services: {
      api: {
        type: "node:{{ recipe.node }}",
        primary: true,
        port: 3000,
        environment: { API_FRAMEWORK: "{{ recipe.framework }}" },
        routes: defaultRoutes,
      },
    },
    tooling: {
      npm: { service: "api", description: "Run npm inside the api service.", cmds: ["npm"] },
      node: { service: "api", description: "Run Node inside the api service.", cmds: ["node"] },
    },
  },
  variants: [
    {
      when: '{{ ne(options.database, "none") }}',
      config: {
        services: {
          api: { environment: { DATABASE_URL: postgresUrl }, dependsOn: ["database"] },
          database: { type: "{{ recipe.database }}" },
        },
      },
    },
  ],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring the Node API up." },
  ],
} as const satisfies RecipeSource;
