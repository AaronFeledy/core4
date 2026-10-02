import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { nextjsProducer, nextjsSnapshot } from "./snapshot.ts";

export const nextjsDecomposer = makeOptionBearingDecomposer({
  producer: nextjsProducer,
  displayName: "Next.js",
  optionTypes: nextjsSnapshot.optionTypes,
  fragment: (input) => {
    const hasDatabase = input.options.database !== "none";
    return {
      services: {
        web: {
          type: "node:{{ recipe.node }}",
          port: 3000,
          environment: { NEXTAUTH_PROVIDER: "{{ recipe.auth }}" },
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
          ...(hasDatabase ? { dependsOn: ["database"] } : {}),
        },
        ...(hasDatabase ? { database: { type: "{{ recipe.database }}" } } : {}),
      },
      tooling: {
        next: {
          service: "web",
          description: "Run the Next.js CLI inside the web service.",
          cmds: ["npx next"],
        },
        npm: { service: "web", description: "Run npm inside the web service.", cmds: ["npm"] },
      },
    };
  },
});
