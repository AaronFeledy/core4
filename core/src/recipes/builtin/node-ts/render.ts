import type { RecipeRenderer } from "../registry.ts";
import { NODE_TS_RECIPE_ID } from "./manifest.ts";

const landofileTs = (appName: string): string => {
  const safeName = JSON.stringify(appName);
  return [
    "// Programmatic Landofile. See spec/07-landofile-and-config.md for the TS-form contract.",
    "// Only documented LandofileContext inputs (ctx.env) are read.",
    "// No forbidden node builtins, URL imports, or relative imports outside the app root.",
    "",
    "export default (ctx: { env: Record<string, string | undefined> }) => ({",
    `  name: ${safeName},`,
    "  services: {",
    "    web: {",
    '      image: `node:${ctx.env.LANDO_NODE_VERSION ?? "lts"}`,',
    '      environment: { NODE_ENV: ctx.env.NODE_ENV ?? "development" },',
    "    },",
    "  },",
    "});",
    "",
  ].join("\n");
};

export const nodeTsRenderer: RecipeRenderer = {
  id: NODE_TS_RECIPE_ID,
  render: ({ appName }) => new Map([[".lando.ts", landofileTs(appName)]]),
};
