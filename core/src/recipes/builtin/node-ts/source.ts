import type { RecipeSource } from "@lando/sdk/schema";
import { defaultRoutes } from "../source-web.ts";

export const source = {
  id: "node-ts",
  title: "Node + environment expressions",
  description:
    "Node service whose canonical Landofile reads its version and environment defaults from the host environment.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["node", "expressions", "typescript"],
  config: {
    runtime: 4,
    services: {
      web: {
        type: "node:{{ default(env.LANDO_NODE_VERSION, 'lts') }}",
        environment: { NODE_ENV: "{{ default(env.NODE_ENV, 'development') }}" },
        routes: defaultRoutes,
      },
    },
  },
  postInit: [
    {
      type: "message",
      text: "Open the generated Landofile to customize its environment expressions before running 'lando start'.",
    },
  ],
} as const satisfies RecipeSource;
