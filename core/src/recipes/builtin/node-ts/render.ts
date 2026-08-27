import type { RecipeRenderer } from "../registry";
import { NODE_TS_RECIPE_ID } from "./manifest";

const landofileTs = (appName: string): string => {
  const safeName = JSON.stringify(appName);
  return [
    "// Programmatic Landofile loaded by Lando at app discovery time.",
    "// This template only reads environment values from the provided context.",
    "// No forbidden node builtins, URL imports, or relative imports outside the app root.",
    "",
    "export default (ctx: { env: Record<string, string | undefined> }) => ({",
    `  name: ${safeName},`,
    "  services: {",
    "    web: {",
    '      image: `node:${ctx.env.LANDO_NODE_VERSION ?? "lts"}`,',
    '      environment: { NODE_ENV: ctx.env.NODE_ENV ?? "development" },',
    `      // primary URL: http(s)://${appName}.lndo.site`,
    '      routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],',
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
