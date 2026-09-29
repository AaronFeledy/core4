import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, call, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const ASTRO_RECIPE_VERSION = "0.1.0";
export const ASTRO_CONTENT_DIGEST = "sha256:21ce77c9cfc6e2fca11be251ad29107346b07d2404817c5eaab596d54f933636";
export const astroProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-astro",
  recipeId: "astro",
  manifestVersion: ASTRO_RECIPE_VERSION,
  contentDigest: ASTRO_CONTENT_DIGEST,
};
export const astroDefaults = { node: "lts", database: "none" } as const;
const databaseEnabled = (): ExpressionNode =>
  call("ne", { kind: "Path", head: "options", segments: [{ type: "prop", name: "database" }] }, lit("none"));
const webService = (hasDatabase: boolean): ExpressionNode =>
  obj([
    ["type", lit("node:{{ recipe.node }}")],
    ["port", lit(4321)],
    ["environment", obj([["ASTRO_TELEMETRY_DISABLED", lit("1")]])],
    ["routes", arr(defaultRoute())],
    ...(hasDatabase ? [["dependsOn", arr(lit("database"))] as const] : []),
  ]);
const web = (): ExpressionNode => cond(databaseEnabled(), webService(true), webService(false));
export const astroSnapshot: RecipeSnapshot = {
  identity: astroProducer,
  optionTypes: {
    node: { kind: "enum", values: ["lts", "22"] },
    database: { kind: "enum", values: ["none", "postgres", "mariadb"] },
  },
  defaults: astroDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        cond(
          databaseEnabled(),
          obj([
            ["web", web()],
            ["database", obj([["type", lit("{{ recipe.database }}")]])],
          ]),
          obj([["web", web()]]),
        ),
      ],
      [
        "tooling",
        obj([
          ["astro", toolNode("web", "Run the Astro CLI inside the web service.", "npx astro")],
          ["npm", toolNode("web", "Run npm inside the web service.", "npm")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const astroSnapshotYaml = recipeSnapshotYaml(astroSnapshot);
