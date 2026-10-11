import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { recipeAssetDigest } from "../snapshot-asset.ts";
import { arr, defaultRoute, encodedStringNode, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { HUGO_BUILD_ARTIFACT } from "./install.ts";
import { HUGO_SCAFFOLD } from "./scaffold.ts";

export const HUGO_RECIPE_VERSION = "0.1.0";
export const HUGO_CONTENT_DIGEST = "sha256:65aa531b997b15eb2bc24861fa71525abfe1491049841c2872c681d8775de0e4";
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
              ["build", obj([["artifact", arr(...HUGO_BUILD_ARTIFACT.map(encodedStringNode))]])],
              ["command", lit("hugo server --bind 0.0.0.0 --port 1313")],
              ["port", lit(1313)],
            ]),
          ],
          [
            "web",
            obj([
              ["type", lit("static:nginx")],
              ["primary", lit(false)],
              ["appMount", obj([["target", lit("/app")]])],
              ["webroot", lit("/app/public")],
              ["routes", arr(defaultRoute())],
            ]),
          ],
        ]),
      ],
      [
        "tooling",
        obj([
          ["hugo", toolNode("builder", "Run the Hugo CLI inside the builder service.", "hugo")],
          ["npm", toolNode("builder", "Run npm inside the builder service.", "npm")],
        ]),
      ],
    ]),
  },
  assets: Object.entries(HUGO_SCAFFOLD).map(([dest, content]) => ({
    dest,
    digest: recipeAssetDigest(content),
    template: dest === "hugo.toml",
  })),
};
export const hugoSnapshotYaml = recipeSnapshotYaml(hugoSnapshot);
