import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { recipeAssetDigest } from "../snapshot-asset.ts";
import { arr, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { MEAN_PACKAGE_JSON_TEMPLATE, MEAN_SERVER_JS } from "./scaffold.ts";

export const MEAN_RECIPE_VERSION = "0.1.0";
export const MEAN_CONTENT_DIGEST = "sha256:d7e6de6d2b9c54794877b71e73e6b520ada7c6f8b9bbf196621934378eeb3fc0";
export const meanProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-mean",
  recipeId: "mean",
  manifestVersion: MEAN_RECIPE_VERSION,
  contentDigest: MEAN_CONTENT_DIGEST,
};
export const meanDefaults = { node: "lts", redis: false } as const;
const redisEnabled = (): ExpressionNode => ({
  kind: "Path",
  head: "options",
  segments: [{ type: "prop", name: "redis" }],
});
const environment = (redis: boolean): ExpressionNode =>
  obj([
    ["NODE_ENV", lit("development")],
    ["PORT", lit(3000)],
    ["MONGO_URL", lit("mongodb://lando:lando@database:27017/{{ app.name }}?authSource=admin")],
    ...(redis ? [["REDIS_URL", lit("redis://cache:6379")] as const] : []),
  ]);
const services = (redis: boolean): ExpressionNode =>
  obj([
    [
      "api",
      obj([
        ["type", lit("node:{{ recipe.node }}")],
        ["primary", lit(true)],
        ["port", lit(3000)],
        ["command", lit("npm install --no-audit --no-fund && exec node server.js")],
        ["environment", cond(redisEnabled(), environment(true), environment(false))],
        ["dependsOn", cond(redisEnabled(), arr(lit("database"), lit("cache")), arr(lit("database")))],
        ["routes", arr(defaultRoute())],
      ]),
    ],
    ["database", obj([["type", lit("mongodb")]])],
    ...(redis ? [["cache", obj([["type", lit("redis")]])] as const] : []),
  ]);
export const meanSnapshot: RecipeSnapshot = {
  identity: meanProducer,
  optionTypes: { node: { kind: "enum", values: ["lts", "22"] }, redis: { kind: "boolean" } },
  defaults: meanDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      ["services", cond(redisEnabled(), services(true), services(false))],
      [
        "tooling",
        obj([
          ["npm", toolNode("api", "Run npm inside the api service.", "npm")],
          ["node", toolNode("api", "Run Node inside the api service.", "node")],
        ]),
      ],
    ]),
  },
  assets: [
    { dest: "package.json", digest: recipeAssetDigest(MEAN_PACKAGE_JSON_TEMPLATE), template: true },
    { dest: "server.js", digest: recipeAssetDigest(MEAN_SERVER_JS), template: true },
  ],
};
export const meanSnapshotYaml = recipeSnapshotYaml(meanSnapshot);
