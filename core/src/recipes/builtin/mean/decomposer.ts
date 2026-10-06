import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { meanProducer, meanSnapshot } from "./snapshot.ts";

export const meanDecomposer = makeOptionBearingDecomposer({
  producer: meanProducer,
  displayName: "MEAN",
  optionTypes: meanSnapshot.optionTypes,
  fragment: (input) => {
    const redis = input.options.redis === true;
    return {
      services: {
        api: {
          type: "node:{{ recipe.node }}",
          primary: true,
          port: 3000,
          command: ["sh", "-c", "npm install --no-audit --no-fund && exec node server.js"],
          environment: {
            NODE_ENV: "development",
            PORT: 3000,
            MONGO_URL: "mongodb://lando:lando@database:27017/{{ app.name }}?authSource=admin",
            ...(redis ? { REDIS_URL: "redis://cache:6379" } : {}),
          },
          dependsOn: redis ? ["database", "cache"] : ["database"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "mongodb" },
        ...(redis ? { cache: { type: "redis" } } : {}),
      },
      tooling: {
        npm: { service: "api", description: "Run npm inside the api service.", cmds: ["npm"] },
        node: { service: "api", description: "Run Node inside the api service.", cmds: ["node"] },
      },
    };
  },
});
