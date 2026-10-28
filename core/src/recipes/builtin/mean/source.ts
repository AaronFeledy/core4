import type { RecipeSource } from "@lando/sdk/schema";
import { defaultRoutes, nodeOption, redisOption } from "../source-web.ts";

export const source = {
  id: "mean",
  title: "MEAN",
  description: "MEAN-style Node API with MongoDB and optional Redis.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["mean", "node", "mongodb"],
  options: { node: nodeOption, redis: redisOption },
  config: {
    runtime: 4,
    services: {
      api: {
        type: "node:{{ recipe.node }}",
        primary: true,
        port: 3000,
        command: "npm install --no-audit --no-fund && exec node server.js",
        environment: {
          NODE_ENV: "development",
          PORT: 3000,
          MONGO_URL:
            "mongodb://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database:{{ services.database.port }}/{{ url.encodeComponent(services.database.creds.database) }}?authSource=admin",
        },
        dependsOn: ["database"],
        routes: defaultRoutes,
      },
      database: { type: "mongodb" },
    },
    tooling: {
      npm: { service: "api", description: "Run npm inside the api service.", cmds: ["npm"] },
      node: { service: "api", description: "Run Node inside the api service.", cmds: ["node"] },
    },
  },
  variants: [
    {
      when: "{{ options.redis }}",
      config: {
        services: {
          api: { environment: { REDIS_URL: "redis://cache:6379" }, dependsOn: ["cache"] },
          cache: { type: "redis" },
        },
      },
    },
  ],
  files: [
    { src: "templates/package.json.tmpl", dest: "package.json", template: true },
    { src: "templates/server.js.tmpl", dest: "server.js", template: true },
  ],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring the MEAN stack up." },
  ],
} as const satisfies RecipeSource;
