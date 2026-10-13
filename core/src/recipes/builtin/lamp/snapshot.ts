import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { PHP_DEFAULT, PHP_VERSIONS, WEBROOT_PATTERN } from "../php-stack.ts";
import { arr, call, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const LAMP_RECIPE_VERSION = "0.1.0";
export const LAMP_CONTENT_DIGEST = "sha256:82c9c3a5c8f8ae44b1be5bd8a68ddfc0bdda51833a8f50ecd7660e6457cb6406";
export const lampProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-lamp",
  recipeId: "lamp",
  manifestVersion: LAMP_RECIPE_VERSION,
  contentDigest: LAMP_CONTENT_DIGEST,
};
export const lampDefaults = {
  php: PHP_DEFAULT,
  database: "mariadb:11.4",
  composer: "2",
  webroot: ".",
} as const;
const composerEnabled = (): ExpressionNode =>
  call("ne", { kind: "Path", head: "options", segments: [{ type: "prop", name: "composer" }] }, lit("false"));
export const lampSnapshot: RecipeSnapshot = {
  identity: lampProducer,
  optionTypes: {
    php: { kind: "enum", values: [...PHP_VERSIONS] },
    database: { kind: "enum", values: ["mariadb:11.4", "mysql:8.0"] },
    composer: { kind: "enum", values: ["2", "2.7.7", "false"] },
    webroot: { kind: "string", pattern: WEBROOT_PATTERN.source },
  },
  defaults: lampDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        obj([
          [
            "appserver",
            obj([
              ["type", lit("php:{{ recipe.php }}")],
              ["primary", lit(true)],
              ["framework", lit("none")],
              ["webroot", lit("{{ recipe.webroot }}")],
              ["composer", cond(composerEnabled(), lit("{{ recipe.composer }}"), lit(false))],
              ["port", lit(80)],
              ["dependsOn", arr(lit("database"))],
              ["routes", arr(defaultRoute())],
            ]),
          ],
          ["database", obj([["type", lit("{{ recipe.database }}")]])],
        ]),
      ],
      [
        "tooling",
        cond(
          composerEnabled(),
          obj([
            ["composer", toolNode("appserver", "Run Composer inside the appserver service.", "composer")],
            ["php", toolNode("appserver", "Run the PHP CLI inside the appserver service.", "php")],
          ]),
          obj([["php", toolNode("appserver", "Run the PHP CLI inside the appserver service.", "php")]]),
        ),
      ],
    ]),
  },
  assets: [],
};
export const lampSnapshotYaml = recipeSnapshotYaml(lampSnapshot);
