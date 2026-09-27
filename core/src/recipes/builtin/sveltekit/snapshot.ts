import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, call, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const SVELTEKIT_RECIPE_VERSION = "0.1.0";
export const SVELTEKIT_CONTENT_DIGEST =
  "sha256:f8a23c071d0f1b1528573a6514c9927ab5f2a64a286be3d5a7e58f9c5bfec469";
export const sveltekitProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-sveltekit",
  recipeId: "sveltekit",
  manifestVersion: SVELTEKIT_RECIPE_VERSION,
  contentDigest: SVELTEKIT_CONTENT_DIGEST,
};
export const sveltekitDefaults = { node: "lts", adapter: "node", database: "none" } as const;
const databaseEnabled = (): ExpressionNode =>
  call("ne", { kind: "Path", head: "options", segments: [{ type: "prop", name: "database" }] }, lit("none"));
const webService = (hasDatabase: boolean): ExpressionNode =>
  obj([
    ["type", lit("node:{{ recipe.node }}")],
    ["port", lit(5173)],
    ["environment", obj([["SVELTEKIT_ADAPTER", lit("{{ recipe.adapter }}")]])],
    ["routes", arr(defaultRoute())],
    ...(hasDatabase ? [["dependsOn", arr(lit("database"))] as const] : []),
  ]);
const web = (): ExpressionNode => cond(databaseEnabled(), webService(true), webService(false));
export const sveltekitSnapshot: RecipeSnapshot = {
  identity: sveltekitProducer,
  optionTypes: {
    node: { kind: "enum", values: ["lts", "22"] },
    adapter: { kind: "enum", values: ["node", "auto"] },
    database: { kind: "enum", values: ["none", "postgres", "mariadb"] },
  },
  defaults: sveltekitDefaults,
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
          ["svelte", toolNode("web", "Run the Svelte CLI inside the web service.", "npx svelte-kit")],
          ["npm", toolNode("web", "Run npm inside the web service.", "npm")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const sveltekitSnapshotYaml = recipeSnapshotYaml(sveltekitSnapshot);
