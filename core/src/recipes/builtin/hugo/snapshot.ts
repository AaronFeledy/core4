import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const HUGO_RECIPE_VERSION = "0.1.0";
export const HUGO_CONTENT_DIGEST = "sha256:6730c7d056b4de022ad9cc17026d2649123d6be3a6f77782daa5073db316168f";
export const hugoProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-hugo",
  recipeId: "hugo",
  manifestVersion: HUGO_RECIPE_VERSION,
  contentDigest: HUGO_CONTENT_DIGEST,
};
export const hugoDefaults = {} as const;
export const hugoSnapshot: RecipeSnapshot = {
  identity: hugoProducer,
  optionTypes: {},
  defaults: hugoDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        obj([
          [
            "builder",
            obj([
              ["type", lit("node:lts")],
              ["primary", lit(true)],
              ["command", lit("npx hugo server --bind 0.0.0.0 --port 1313")],
              ["port", lit(1313)],
            ]),
          ],
          [
            "web",
            obj([
              ["type", lit("static:nginx")],
              ["primary", lit(false)],
              ["appMount", obj([["target", lit("/app")]])],
              ["routes", arr(defaultRoute())],
            ]),
          ],
        ]),
      ],
      [
        "tooling",
        obj([
          ["hugo", toolNode("builder", "Run the Hugo CLI inside the builder service.", "npx hugo")],
          ["npm", toolNode("builder", "Run npm inside the builder service.", "npm")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const hugoSnapshotYaml = recipeSnapshotYaml(hugoSnapshot);
