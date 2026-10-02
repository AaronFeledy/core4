import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { nodePostgresProducer } from "./snapshot.ts";

export const nodePostgresDecomposer = makeZeroOptionDecomposer({
  producer: nodePostgresProducer,
  displayName: "Node-postgres",
  fragment: () => ({
    services: {
      web: {
        type: "node:lts",
        ports: ["3000:3000"],
        environment: { NODE_ENV: "development" },
        volumes: ["./:/app"],
        command: "node /app/server.js",
        dependsOn: ["database"],
        routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
      },
      database: { type: "postgres" },
    },
  }),
});
