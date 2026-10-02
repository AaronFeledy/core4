import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { recipeAssetDigest } from "../snapshot-asset.ts";
import { arr, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { RAILS_GEMFILE } from "./scaffold.ts";

export const RAILS_RECIPE_VERSION = "0.1.0";
export const RAILS_CONTENT_DIGEST = "sha256:1faa3a1a496dabcb300229d0db14e0e2d570506e785391f9332947d2b1febd65";
export const railsProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-rails",
  recipeId: "rails",
  manifestVersion: RAILS_RECIPE_VERSION,
  contentDigest: RAILS_CONTENT_DIGEST,
};
export const railsDefaults = {} as const;
const serviceOfType = (type: string): ExpressionNode => obj([["type", lit(type)]]);
export const railsSnapshot: RecipeSnapshot = {
  identity: railsProducer,
  optionTypes: {},
  defaults: railsDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        obj([
          [
            "web",
            obj([
              ["type", lit("ruby:3.3")],
              ["framework", lit("rails")],
              ["port", lit(3000)],
              [
                "build",
                obj([
                  [
                    "artifact",
                    arr(
                      lit("apt-get update && apt-get install -y --no-install-recommends build-essential"),
                      lit("gem install rails --no-document"),
                    ),
                  ],
                ]),
              ],
              ["dependsOn", arr(lit("database"), lit("cache"))],
              ["routes", arr(defaultRoute())],
            ]),
          ],
          ["database", serviceOfType("postgres")],
          ["cache", serviceOfType("redis")],
        ]),
      ],
      [
        "tooling",
        obj([
          ["rails", toolNode("web", "Run the Rails CLI inside the web service.", "rails")],
          ["bundle", toolNode("web", "Run Bundler inside the web service.", "bundle")],
        ]),
      ],
    ]),
  },
  assets: [{ dest: "Gemfile", digest: recipeAssetDigest(RAILS_GEMFILE), template: false }],
};
export const railsSnapshotYaml = recipeSnapshotYaml(railsSnapshot);
