import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const LEMP_RECIPE_VERSION = "0.1.0";
export const LEMP_CONTENT_DIGEST = "sha256:67331adb4acec417a95838f782c2cf77a21c760f9de5e27632c65e2d1446ad33";
export const lempProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-lemp",
  recipeId: "lemp",
  manifestVersion: LEMP_RECIPE_VERSION,
  contentDigest: LEMP_CONTENT_DIGEST,
};
export const lempSnapshot: RecipeSnapshot = {
  identity: lempProducer,
  optionTypes: { php: { kind: "enum", values: ["8.2", "8.3"] } },
  defaults: { php: "8.3" },
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        obj([
          [
            "web",
            obj([
              ["type", lit("nginx")],
              ["primary", lit(false)],
              ["port", lit(80)],
              ["dependsOn", arr(lit("appserver"))],
              ["routes", arr(defaultRoute())],
            ]),
          ],
          [
            "appserver",
            obj([
              ["type", lit("php:{{ recipe.php }}")],
              ["primary", lit(true)],
              ["framework", lit("none")],
              ["dependsOn", arr(lit("database"))],
            ]),
          ],
          ["database", obj([["type", lit("mariadb")]])],
        ]),
      ],
      [
        "tooling",
        obj([
          ["composer", toolNode("appserver", "Run Composer inside the appserver service.", "composer")],
          ["php", toolNode("appserver", "Run the PHP CLI inside the appserver service.", "php")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const lempSnapshotYaml = recipeSnapshotYaml(lempSnapshot);
