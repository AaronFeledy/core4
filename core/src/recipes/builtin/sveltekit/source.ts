import type { RecipeSource } from "@lando/sdk/schema";
import { nodeOption, nodeWebService, optionalWebDatabase } from "../source-web.ts";

export const source = {
  id: "sveltekit",
  title: "SvelteKit",
  description: "SvelteKit frontend with an adapter picker and optional database.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["sveltekit", "svelte", "node"],
  options: {
    node: nodeOption,
    adapter: {
      type: { kind: "enum", values: ["node", "auto"] },
      default: "node",
      prompt: { message: "SvelteKit adapter" },
    },
    database: {
      type: { kind: "enum", values: ["none", "postgres", "mariadb"] },
      default: "none",
      prompt: { message: "Database" },
    },
  },
  config: {
    runtime: 4,
    services: { web: nodeWebService(5173, { SVELTEKIT_ADAPTER: "{{ recipe.adapter }}" }) },
    tooling: {
      svelte: {
        service: "web",
        description: "Run the Svelte CLI inside the web service.",
        cmds: ["npx svelte-kit"],
      },
      npm: { service: "web", description: "Run npm inside the web service.", cmds: ["npm"] },
    },
  },
  variants: [optionalWebDatabase],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring SvelteKit up." },
  ],
} as const satisfies RecipeSource;
