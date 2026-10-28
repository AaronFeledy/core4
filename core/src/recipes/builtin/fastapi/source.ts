import type { RecipeSource } from "@lando/sdk/schema";
import { defaultRoutes } from "../source-web.ts";
import { FASTAPI_ENTRYPOINT, FASTAPI_ENVIRONMENT } from "./startup.ts";

export const source = {
  id: "fastapi",
  title: "FastAPI",
  description: "FastAPI with PostgreSQL and Redis.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["fastapi", "python"],
  config: {
    runtime: 4,
    services: {
      web: {
        type: "python:3.12",
        framework: "fastapi",
        port: 8000,
        entrypoint: FASTAPI_ENTRYPOINT,
        environment: FASTAPI_ENVIRONMENT,
        dependsOn: ["database", "cache"],
        routes: defaultRoutes,
      },
      database: { type: "postgres" },
      cache: { type: "redis" },
    },
    tooling: {
      uvicorn: { service: "web", description: "Run uvicorn inside the web service.", cmds: ["uvicorn"] },
      pip: { service: "web", description: "Run pip inside the web service.", cmds: ["pip"] },
    },
  },
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring FastAPI up." },
  ],
} as const satisfies RecipeSource;
