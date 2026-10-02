import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, call, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const NODE_API_RECIPE_VERSION = "0.1.0";
export const NODE_API_CONTENT_DIGEST =
  "sha256:8f8d44bb5a545862ab890596e276df763554539f02259051853a3da3d7968227";
export const nodeApiProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-node-api",
  recipeId: "node-api",
  manifestVersion: NODE_API_RECIPE_VERSION,
  contentDigest: NODE_API_CONTENT_DIGEST,
};
export const nodeApiDefaults = { node: "lts", framework: "express", database: "postgres" } as const;
const databaseEnabled = (): ExpressionNode =>
  call("ne", { kind: "Path", head: "options", segments: [{ type: "prop", name: "database" }] }, lit("none"));
const apiService = (hasDatabase: boolean): ExpressionNode =>
  obj([
    ["type", lit("node:{{ recipe.node }}")],
    ["primary", lit(true)],
    ["port", lit(3000)],
    ["environment", obj([["API_FRAMEWORK", lit("{{ recipe.framework }}")]])],
    ["routes", arr(defaultRoute())],
    ...(hasDatabase ? [["dependsOn", arr(lit("database"))] as const] : []),
  ]);
const api = (): ExpressionNode => cond(databaseEnabled(), apiService(true), apiService(false));
export const nodeApiSnapshot: RecipeSnapshot = {
  identity: nodeApiProducer,
  optionTypes: {
    node: { kind: "enum", values: ["lts", "22"] },
    framework: { kind: "enum", values: ["express", "fastify", "hono"] },
    database: { kind: "enum", values: ["postgres", "none"] },
  },
  defaults: nodeApiDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        cond(
          databaseEnabled(),
          obj([
            ["api", api()],
            ["database", obj([["type", lit("{{ recipe.database }}")]])],
          ]),
          obj([["api", api()]]),
        ),
      ],
      [
        "tooling",
        obj([
          ["npm", toolNode("api", "Run npm inside the api service.", "npm")],
          ["node", toolNode("api", "Run Node inside the api service.", "node")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const nodeApiSnapshotYaml = recipeSnapshotYaml(nodeApiSnapshot);
