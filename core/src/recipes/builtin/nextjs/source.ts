import type { RecipeSource } from "@lando/sdk/schema";
import { nodeOption, nodeWebService, optionalWebDatabase } from "../source-web.ts";
import { NEXTJS_SCAFFOLD_COMMAND } from "./scaffold-command.ts";

export const source = {
  id: "nextjs",
  title: "Next.js",
  description: "Next.js frontend with optional database and Auth helper picker.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["nextjs", "react", "node"],
  options: {
    node: nodeOption,
    database: {
      type: { kind: "enum", values: ["none", "postgres", "mariadb"] },
      default: "postgres",
      prompt: { message: "Database" },
    },
    auth: {
      type: { kind: "enum", values: ["none", "nextauth", "clerk"] },
      default: "none",
      prompt: { message: "Auth helper" },
    },
  },
  config: {
    runtime: 4,
    services: { web: nodeWebService(3000, { NEXTAUTH_PROVIDER: "{{ recipe.auth }}" }) },
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
  },
  variants: [optionalWebDatabase],
  postInit: [
    {
      type: "message",
      text: "This recipe creates Lando configuration only. Inside the new app directory, run 'lando start', then 'lando nextjs-scaffold' to create Next.js sources and install dependencies, then 'lando next dev' to run the dev server.",
    },
  ],
} as const satisfies RecipeSource;
