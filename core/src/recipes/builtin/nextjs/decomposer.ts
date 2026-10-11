import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { NEXTJS_SCAFFOLD_COMMAND } from "./scaffold-command.ts";
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
        "nextjs-scaffold": {
          service: "web",
          description: "Scaffold a Next.js app and install dependencies in the mounted app root.",
          arguments: false,
          cmd: NEXTJS_SCAFFOLD_COMMAND,
        },
      },
    };
  },
});
