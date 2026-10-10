import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { fastapiProducer } from "./snapshot.ts";
import { FASTAPI_ENTRYPOINT, FASTAPI_ENVIRONMENT } from "./startup.ts";

export const fastapiDecomposer = makeZeroOptionDecomposer({
  producer: fastapiProducer,
  displayName: "FastAPI",
  fragment: () => ({
    services: {
      web: {
        type: "python:3.12",
        framework: "fastapi",
        port: 8000,
        entrypoint: [...FASTAPI_ENTRYPOINT],
        environment: { ...FASTAPI_ENVIRONMENT },
        dependsOn: ["database", "cache"],
        routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
      },
      database: { type: "postgres" },
      cache: { type: "redis" },
    },
    tooling: {
      uvicorn: { service: "web", description: "Run uvicorn inside the web service.", cmds: ["uvicorn"] },
      pip: { service: "web", description: "Run pip inside the web service.", cmds: ["pip"] },
    },
  }),
});
