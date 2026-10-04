import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { sveltekitProducer, sveltekitSnapshot } from "./snapshot.ts";

export const sveltekitDecomposer = makeOptionBearingDecomposer({
  producer: sveltekitProducer,
  displayName: "SvelteKit",
  optionTypes: sveltekitSnapshot.optionTypes,
  fragment: (input) => {
    const hasDatabase = input.options.database !== "none";
    return {
      services: {
        web: {
          type: "node:{{ recipe.node }}",
          port: 5173,
          environment: { SVELTEKIT_ADAPTER: "{{ recipe.adapter }}" },
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
          ...(hasDatabase ? { dependsOn: ["database"] } : {}),
        },
        ...(hasDatabase ? { database: { type: "{{ recipe.database }}" } } : {}),
      },
      tooling: {
        svelte: {
          service: "web",
          description: "Run the Svelte CLI inside the web service.",
          cmds: ["npx svelte-kit"],
        },
        npm: { service: "web", description: "Run npm inside the web service.", cmds: ["npm"] },
      },
    };
  },
});
