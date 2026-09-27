import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const JEKYLL_RECIPE_VERSION = "0.1.0";
export const JEKYLL_CONTENT_DIGEST =
  "sha256:9d470a4c579e020b45abe1c8115fac24f98b883dceb6daf312b8964c98ce2ad6";
export const jekyllProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-jekyll",
  recipeId: "jekyll",
  manifestVersion: JEKYLL_RECIPE_VERSION,
  contentDigest: JEKYLL_CONTENT_DIGEST,
};
export const jekyllDefaults = {} as const;
export const jekyllSnapshot: RecipeSnapshot = {
  identity: jekyllProducer,
  optionTypes: {},
  defaults: jekyllDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        obj([
          [
            "builder",
            obj([
              ["type", lit("ruby:3.3")],
              ["primary", lit(true)],
              ["framework", lit("none")],
              ["command", lit("bundle exec jekyll serve --host 0.0.0.0 --port 4000")],
              ["port", lit(4000)],
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
            "jekyll",
            toolNode("builder", "Run the Jekyll CLI inside the builder service.", "bundle exec jekyll"),
          ],
          ["bundle", toolNode("builder", "Run Bundler inside the builder service.", "bundle")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const jekyllSnapshotYaml = recipeSnapshotYaml(jekyllSnapshot);
