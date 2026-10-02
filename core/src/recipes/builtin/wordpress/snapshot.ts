import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, call, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const WORDPRESS_RECIPE_VERSION = "0.1.0";
export const WORDPRESS_CONTENT_DIGEST =
  "sha256:97fa603f460a19a7e207f6269f64c4fddd9cffd64bee21647d080aa2ccef24bf";
export const wordpressProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-wordpress",
  recipeId: "wordpress",
  manifestVersion: WORDPRESS_RECIPE_VERSION,
  contentDigest: WORDPRESS_CONTENT_DIGEST,
};
export const wordpressSnapshot: RecipeSnapshot = {
  identity: wordpressProducer,
  optionTypes: { php: { kind: "enum", values: ["8.2", "8.3"] }, redis: { kind: "boolean" } },
  defaults: { php: "8.3", redis: false },
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        call(
          "merge",
          obj([
            [
              "appserver",
              obj([
                ["type", lit("php:{{ recipe.php }}")],
                ["primary", lit(true)],
                ["framework", lit("wordpress")],
                ["port", lit(80)],
                [
                  "dependsOn",
                  cond(
                    { kind: "Path", head: "options", segments: [{ type: "prop", name: "redis" }] },
                    arr(lit("database"), lit("cache")),
                    arr(lit("database")),
                  ),
                ],
                ["routes", arr(defaultRoute())],
              ]),
            ],
            ["database", obj([["type", lit("mariadb")]])],
          ]),
          cond(
            { kind: "Path", head: "options", segments: [{ type: "prop", name: "redis" }] },
            obj([["cache", obj([["type", lit("redis")]])]]),
            obj([]),
          ),
        ),
      ],
      [
        "tooling",
        obj([
          ["wp", toolNode("appserver", "Run WP-CLI inside the appserver service.", "wp")],
          ["composer", toolNode("appserver", "Run Composer inside the appserver service.", "composer")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const wordpressSnapshotYaml = recipeSnapshotYaml(wordpressSnapshot);
