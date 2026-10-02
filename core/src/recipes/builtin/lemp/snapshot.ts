import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const LEMP_RECIPE_VERSION = "0.1.0";
export const LEMP_CONTENT_DIGEST = "sha256:c6839506f4d6f84a185dd4ad04c78a900774d1cb105489b58930f611b186080b";
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
              ["backend", lit("appserver")],
              ["webroot", lit("/app")],
              ["routes", arr(defaultRoute())],
            ]),
          ],
          [
            "appserver",
            obj([
              ["type", lit("php:{{ recipe.php }}")],
              ["primary", lit(true)],
              ["framework", lit("none")],
              ["via", lit("fpm")],
              ["webroot", lit("/app")],
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
