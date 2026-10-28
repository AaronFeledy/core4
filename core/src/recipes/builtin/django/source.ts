import type { RecipeSource } from "@lando/sdk/schema";
import { defaultRoutes, postgresUrl } from "../source-web.ts";

const environment = {
  DJANGO_SETTINGS_MODULE: "config.settings",
  DATABASE_URL: postgresUrl,
  REDIS_URL: "redis://cache:6379",
} as const;

export const source = {
  id: "django",
  title: "Django",
  description: "Django with PostgreSQL, Redis, and an optional Celery worker.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["django", "python"],
  options: {
    celery: {
      type: { kind: "boolean" },
      default: false,
      prompt: { message: "Add a Celery worker service?" },
    },
  },
  config: {
    runtime: 4,
    services: {
      web: {
        type: "python:3.12",
        framework: "django",
        port: 8000,
        environment,
        dependsOn: ["database", "cache"],
        routes: defaultRoutes,
      },
      database: { type: "postgres" },
      cache: { type: "redis" },
    },
    tooling: {
      django: {
        service: "web",
        description: "Run the Django management script inside the web service.",
        cmds: ["python manage.py"],
      },
      pip: { service: "web", description: "Run pip inside the web service.", cmds: ["pip"] },
    },
  },
  variants: [
    {
      when: "{{ options.celery }}",
      config: {
        services: {
          worker: {
            type: "python:3.12",
            framework: "django",
            command: "celery -A app worker --loglevel=info",
            restart: "unless-stopped",
            environment,
            dependsOn: ["database", "cache"],
          },
        },
      },
    },
  ],
  postInit: [
    {
      type: "message",
      text: "Run 'lando start' inside the new app directory to start the containers. Once Django is installed, run 'lando django runserver 0.0.0.0:8000' to serve the app.",
    },
  ],
} as const satisfies RecipeSource;
