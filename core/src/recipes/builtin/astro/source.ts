import type { RecipeSource } from "@lando/sdk/schema";
import { nodeOption, nodeWebService, optionalWebDatabase } from "../source-web.ts";

export const source = {
  id: "astro",
  title: "Astro",
  description: "Astro frontend with an optional content-source database picker.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["astro", "node", "frontend"],
  options: {
    node: nodeOption,
    database: {
      type: { kind: "enum", values: ["none", "postgres", "mariadb"] },
      default: "none",
      prompt: { message: "Content-source database" },
    },
  },
  config: {
    runtime: 4,
    services: { web: nodeWebService(4321, { ASTRO_TELEMETRY_DISABLED: "1" }) },
    tooling: {
      astro: {
        service: "web",
        description: "Run the Astro CLI inside the web service.",
        cmds: ["npx astro"],
      },
      npm: { service: "web", description: "Run npm inside the web service.", cmds: ["npm"] },
    },
  },
  variants: [optionalWebDatabase],
  postInit: [{ type: "message", text: "Run 'lando start' inside the new app directory to bring Astro up." }],
} as const satisfies RecipeSource;
