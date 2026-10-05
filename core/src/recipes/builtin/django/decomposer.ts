import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { djangoProducer, djangoSnapshot } from "./snapshot.ts";

export const djangoDecomposer = makeOptionBearingDecomposer({
  producer: djangoProducer,
  displayName: "Django",
  optionTypes: djangoSnapshot.optionTypes,
  fragment: (input) => {
    const hasWorker = input.options.celery === true;
    return {
      services: {
        web: {
          type: "python:3.12",
          framework: "django",
          port: 8000,
          environment: {
            DATABASE_URL:
              "postgresql://{{ services.database.creds.user }}:{{ services.database.creds.password }}@database:5432/{{ services.database.creds.database }}",
            REDIS_URL: "redis://cache:6379",
          },
          dependsOn: ["database", "cache"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "postgres" },
        cache: { type: "redis" },
        ...(hasWorker
          ? {
              worker: {
                type: "python:3.12",
                framework: "django",
                command: "celery -A app worker --loglevel=info",
                environment: {
                  DATABASE_URL:
                    "postgresql://{{ services.database.creds.user }}:{{ services.database.creds.password }}@database:5432/{{ services.database.creds.database }}",
                  REDIS_URL: "redis://cache:6379",
                },
                dependsOn: ["database", "cache"],
              },
            }
          : {}),
      },
      tooling: {
        django: {
          service: "web",
          description: "Run the Django management script inside the web service.",
          cmds: ["python manage.py"],
        },
        pip: { service: "web", description: "Run pip inside the web service.", cmds: ["pip"] },
      },
    };
  },
});
