import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const ELEVENTY_RECIPE_VERSION = "0.1.0";
export const ELEVENTY_CONTENT_DIGEST =
  "sha256:89591241116d13890e347502e7e25c2a9ace413e695cb217728602466ec7ace1";
export const eleventyProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-eleventy",
  recipeId: "eleventy",
  manifestVersion: ELEVENTY_RECIPE_VERSION,
  contentDigest: ELEVENTY_CONTENT_DIGEST,
};
export const eleventyDefaults = {} as const;
export const eleventySnapshot: RecipeSnapshot = {
  identity: eleventyProducer,
  optionTypes: {},
  defaults: eleventyDefaults,
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
              ["command", lit("npx @11ty/eleventy --serve --port 8080")],
              ["port", lit(8080)],
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
          [
            "eleventy",
            toolNode("builder", "Run the Eleventy CLI inside the builder service.", "npx @11ty/eleventy"),
          ],
          ["npm", toolNode("builder", "Run npm inside the builder service.", "npm")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const eleventySnapshotYaml = recipeSnapshotYaml(eleventySnapshot);
