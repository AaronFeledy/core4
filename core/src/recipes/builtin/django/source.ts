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
  description: "Django with PostgreSQL or SQLite, Redis, and an optional Celery worker.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["django", "python"],
  options: {
    database: {
      type: { kind: "enum", values: ["postgres", "sqlite"] },
      default: "postgres",
      prompt: { message: "Database" },
    },
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
        depends_on: ["cache"],
        routes: defaultRoutes,
      },
      cache: { type: "redis" },
    },
    tooling: {
      django: {
        service: "web",
        description: "Run the Django management script inside the web service.",
        cmds: ["python manage.py"],
        wrapper: true,
      },
      pip: {
        service: "web",
        description: "Run pip in the shared Python environment.",
        cmds: ["python -m pip"],
        wrapper: true,
      },
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
            command: "exec celery -A config worker --loglevel=info",
            endpoints: [],
            restart: "unless-stopped",
            environment,
            depends_on: ["cache"],
          },
        },
      },
    },
    {
      when: '{{ eq(options.database, "postgres") }}',
      config: {
        services: { web: { depends_on: ["database", "cache"] }, database: { type: "postgres" } },
      },
    },
    {
      when: '{{ and(options.celery, eq(options.database, "postgres")) }}',
      config: { services: { worker: { depends_on: ["database", "cache"] } } },
    },
    {
      when: '{{ eq(options.database, "sqlite") }}',
      config: {
        services: {
          web: {
            appMount: { target: "/app" },
            sqlite: { path: "db.sqlite3" },
            environment: { DATABASE_URL: "sqlite:////app/db.sqlite3" },
          },
        },
      },
    },
    {
      when: '{{ and(options.celery, eq(options.database, "sqlite")) }}',
      config: { services: { worker: { environment: { DATABASE_URL: "sqlite:////app/db.sqlite3" } } } },
    },
  ],
  postInit: [
    {
      type: "message",
      text: "Run 'lando start' inside the new app directory to start the containers. Once Django is installed, run 'lando django runserver 0.0.0.0:8000' to serve the app.",
    },
  ],
} as const satisfies RecipeSource;
