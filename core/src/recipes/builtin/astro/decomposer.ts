import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { astroProducer, astroSnapshot } from "./snapshot.ts";

export const astroDecomposer = makeOptionBearingDecomposer({
  producer: astroProducer,
  displayName: "Astro",
  optionTypes: astroSnapshot.optionTypes,
  fragment: (input) => {
    const hasDatabase = input.options.database !== "none";
    return {
      services: {
        web: {
          type: "node:{{ recipe.node }}",
          port: 4321,
          environment: { ASTRO_TELEMETRY_DISABLED: "1" },
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
          ...(hasDatabase ? { dependsOn: ["database"] } : {}),
        },
        ...(hasDatabase ? { database: { type: "{{ recipe.database }}" } } : {}),
      },
      tooling: {
        astro: {
          service: "web",
          description: "Run the Astro CLI inside the web service.",
          cmds: ["npx astro"],
        },
        npm: { service: "web", description: "Run npm inside the web service.", cmds: ["npm"] },
      },
    };
  },
});
