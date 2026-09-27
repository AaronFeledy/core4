import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { recipeAssetDigest } from "../snapshot-asset.ts";
import { arr, defaultRoute, lit, obj } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { NODE_POSTGRES_PACKAGE_JSON_TEMPLATE, NODE_POSTGRES_SERVER_JS } from "./scaffold.ts";

export const NODE_POSTGRES_RECIPE_VERSION = "0.1.0";
export const NODE_POSTGRES_CONTENT_DIGEST =
  "sha256:cbaec387ad0911dd659f35ad6970123cd4c4668f10b3b7ad1d5ae768c76975a0";
export const nodePostgresProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-node-postgres",
  recipeId: "node-postgres",
  manifestVersion: NODE_POSTGRES_RECIPE_VERSION,
  contentDigest: NODE_POSTGRES_CONTENT_DIGEST,
};
export const nodePostgresDefaults = {} as const;
export const nodePostgresSnapshot: RecipeSnapshot = {
  identity: nodePostgresProducer,
  optionTypes: {},
  defaults: nodePostgresDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        obj([
          [
            "web",
            obj([
              ["type", lit("node:lts")],
              ["ports", arr(lit("3000:3000"))],
              ["environment", obj([["NODE_ENV", lit("development")]])],
              ["volumes", arr(lit("./:/app"))],
              ["command", lit("node /app/server.js")],
              ["dependsOn", arr(lit("database"))],
              ["routes", arr(defaultRoute())],
            ]),
          ],
          ["database", obj([["type", lit("postgres")]])],
        ]),
      ],
    ]),
  },
  assets: [
    { dest: "package.json", digest: recipeAssetDigest(NODE_POSTGRES_PACKAGE_JSON_TEMPLATE), template: true },
    { dest: "server.js", digest: recipeAssetDigest(NODE_POSTGRES_SERVER_JS), template: false },
  ],
};
export const nodePostgresSnapshotYaml = recipeSnapshotYaml(nodePostgresSnapshot);
