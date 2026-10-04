import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { PHP_DEFAULT, PHP_VERSIONS } from "../php-stack.ts";
import { arr, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const LEMP_RECIPE_VERSION = "0.1.0";
export const LEMP_CONTENT_DIGEST = "sha256:edb0a8929bf04db3311d952be330d1b9fce8dbca6fe2340c11661c14e613c0e9";
export const lempProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-lemp",
  recipeId: "lemp",
  manifestVersion: LEMP_RECIPE_VERSION,
  contentDigest: LEMP_CONTENT_DIGEST,
};
export const lempSnapshot: RecipeSnapshot = {
  identity: lempProducer,
  optionTypes: { php: { kind: "enum", values: [...PHP_VERSIONS] } },
  defaults: { php: PHP_DEFAULT },
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
