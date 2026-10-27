import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { recipeAssetDigest } from "../snapshot-asset.ts";
import { arr, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { RAILS_GEMFILE } from "./scaffold.ts";

export const RAILS_RECIPE_VERSION = "0.1.0";
export const RAILS_CONTENT_DIGEST = "sha256:dfdcaac443cabe74d0f0f5b3d8b8cf8711495be0ea3a0cee2f01a68921b16903";
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
              ["webroot", lit("public")],
              ["port", lit(3000)],
              [
                "environment",
                obj([
                  ["RAILS_ENV", lit("development")],
                  ["RAILS_LOG_TO_STDOUT", lit("true")],
                  [
                    "DATABASE_URL",
                    lit(
                      "postgresql://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database:{{ services.database.port }}/{{ url.encodeComponent(services.database.creds.database) }}",
                    ),
                  ],
                  ["REDIS_URL", lit("redis://cache:6379")],
                ]),
              ],
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
          ["rake", toolNode("web", "Run Rake inside the web service.", "rake")],
        ]),
      ],
    ]),
  },
  assets: [{ dest: "Gemfile", digest: recipeAssetDigest(RAILS_GEMFILE), template: false }],
};
export const railsSnapshotYaml = recipeSnapshotYaml(railsSnapshot);
