import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { nodeApiProducer, nodeApiSnapshot } from "./snapshot.ts";

export const nodeApiDecomposer = makeOptionBearingDecomposer({
  producer: nodeApiProducer,
  displayName: "Node API",
  optionTypes: nodeApiSnapshot.optionTypes,
  fragment: (input) => {
    const hasDatabase = input.options.database !== "none";
    return {
      services: {
        api: {
          type: "node:{{ recipe.node }}",
          primary: true,
          port: 3000,
          environment: { API_FRAMEWORK: "{{ recipe.framework }}" },
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
          ...(hasDatabase ? { dependsOn: ["database"] } : {}),
        },
        ...(hasDatabase ? { database: { type: "{{ recipe.database }}" } } : {}),
      },
      tooling: {
        npm: { service: "api", description: "Run npm inside the api service.", cmds: ["npm"] },
        node: { service: "api", description: "Run Node inside the api service.", cmds: ["node"] },
      },
    };
  },
});
