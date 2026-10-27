import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, defaultRoute, lit, obj } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const NODE_TS_RECIPE_VERSION = "0.1.0";
export const NODE_TS_CONTENT_DIGEST =
  "sha256:23b25b9ec8ffcf2d63430b8c0f8232bcac5beb2a02ac03c9fccd88113cf649d1";
export const nodeTsProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-node-ts",
  recipeId: "node-ts",
  manifestVersion: NODE_TS_RECIPE_VERSION,
  contentDigest: NODE_TS_CONTENT_DIGEST,
};
export const nodeTsDefaults = {} as const;
export const nodeTsSnapshot: RecipeSnapshot = {
  identity: nodeTsProducer,
  optionTypes: {},
  defaults: nodeTsDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        obj([
          [
            "web",
            obj([
              ["image", lit("node:{{ default(env.LANDO_NODE_VERSION, '24') }}")],
              ["environment", obj([["NODE_ENV", lit("{{ default(env.NODE_ENV, 'development') }}")]])],
              ["routes", arr(defaultRoute())],
            ]),
          ],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const nodeTsSnapshotYaml = recipeSnapshotYaml(nodeTsSnapshot);
