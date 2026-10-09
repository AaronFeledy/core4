import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { PHP_DEFAULT, PHP_VERSIONS } from "../php-stack.ts";
import { arr, call, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const LARAVEL_RECIPE_VERSION = "0.1.0";
export const LARAVEL_CONTENT_DIGEST =
  "sha256:9d0a43bc508ef91bf00d51e85bb554b3349761fc2929ac2d4f9b34f77d8dc652";
export const laravelProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-laravel",
  recipeId: "laravel",
  manifestVersion: LARAVEL_RECIPE_VERSION,
  contentDigest: LARAVEL_CONTENT_DIGEST,
};
const expression: ExpressionNode = obj([
  ["runtime", lit(4)],
  [
    "services",
    call(
      "merge",
      obj([
        [
          "appserver",
          call(
            "merge",
            obj([
              ["type", lit("php:{{ recipe.php }}")],
              ["primary", lit(true)],
              ["framework", lit("laravel")],
              ["webroot", lit("{{ recipe.webroot }}")],
              ["composer", lit("{{ recipe.composer }}")],
              ["allowOverride", lit(true)],
              ["port", lit(80)],
              ["dependsOn", arr(lit("database"), lit("cache"))],
              ["routes", arr(defaultRoute())],
            ]),
            cond(
              call(
                "eq",
                { kind: "Path", head: "options", segments: [{ type: "prop", name: "worker" }] },
                lit(true),
              ),
              obj([
                [
                  "appMount",
                  obj([
                    ["target", lit("/app")],
                    ["includes", arr(lit("vendor"))],
                  ]),
                ],
              ]),
              obj([]),
            ),
          ),
        ],
        ["database", obj([["type", lit("{{ recipe.database }}")]])],
        ["cache", obj([["type", lit("redis")]])],
        [
          "node",
          obj([
            ["type", lit("node:22")],
            ["primary", lit(false)],
            ["endpoints", arr()],
          ]),
        ],
      ]),
      cond(
        call(
          "eq",
          { kind: "Path", head: "options", segments: [{ type: "prop", name: "worker" }] },
          lit(true),
        ),
        obj([
          [
            "worker",
            obj([
              ["type", lit("php:{{ recipe.php }}")],
              ["framework", lit("laravel")],
              ["via", lit("cli")],
              ["command", lit("php artisan queue:work")],
              ["dependsOn", arr(lit("database"), lit("cache"))],
              [
                "appMount",
                obj([
                  ["target", lit("/app")],
                  ["includes", arr(lit("vendor"))],
                ]),
              ],
            ]),
          ],
        ]),
        obj([]),
      ),
    ),
  ],
  [
    "tooling",
    obj([
      [
        "artisan",
        toolNode("appserver", "Run a Laravel Artisan command inside the appserver service.", "php artisan"),
      ],
      ["composer", toolNode("appserver", "Run Composer inside the appserver service.", "composer")],
      ["npm", toolNode("node", "Run npm inside the node service.", "npm")],
    ]),
  ],
]);
export const laravelSnapshot: RecipeSnapshot = {
  identity: laravelProducer,
  optionTypes: {
    php: { kind: "enum", values: [...PHP_VERSIONS] },
    database: { kind: "enum", values: ["mariadb:11.4", "postgres:16"] },
    composer: { kind: "enum", values: ["2", "2.7.7"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
    worker: { kind: "boolean" },
  },
  defaults: {
    php: PHP_DEFAULT,
    database: "mariadb:11.4",
    composer: "2",
    webroot: "/app/public",
    worker: false,
  },
  template: { expression },
  assets: [],
};
export const laravelSnapshotYaml = recipeSnapshotYaml(laravelSnapshot);
