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
        cmd: [":node-local", "svelte-kit"],
        wrapper: true,
      },
      dev: {
        service: "web",
        description: "Run the Vite dev server on the address Lando publishes.",
        cmd: [":node-local", "vite", "dev", "--host", "0.0.0.0", "--port", "5173", "--strictPort"],
        env: { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "{{ url.parse(services.web.url).hostname }}" },
        wrapper: true,
      },
    },
  },
  variants: [optionalWebDatabase],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to bring SvelteKit up." },
  ],
} as const satisfies RecipeSource;
