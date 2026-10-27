import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { PHP_DEFAULT, PHP_VERSIONS, WEBROOT_PATTERN } from "../php-stack.ts";
import {
  arr,
  call,
  cond,
  defaultRoute,
  encodedStringNode,
  lit,
  obj,
  toolNode,
} from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { backdropSettings } from "./settings.ts";

export const BACKDROP_RECIPE_VERSION = "0.1.0";
export const BACKDROP_CONTENT_DIGEST =
  "sha256:e9733cf3573d04092019adcb32893dc0851a91ab4ce38010fe05524fea98edf0";
export const backdropProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-backdrop",
  recipeId: "backdrop",
  manifestVersion: BACKDROP_RECIPE_VERSION,
  contentDigest: BACKDROP_CONTENT_DIGEST,
};
export const backdropDefaults = {
  php: PHP_DEFAULT,
  database: "mariadb:11.4",
  composer: "2",
  webroot: ".",
} as const;
/** Backdrop reads its database credentials from this app-scoped settings blob. */
export const BACKDROP_SETTINGS_VALUE = backdropSettings("{{ app.name }}");
const composerEnabled = (): ExpressionNode =>
  call("ne", { kind: "Path", head: "options", segments: [{ type: "prop", name: "composer" }] }, lit("false"));
const BEE_TOOL_DESCRIPTION = "Run Bee inside the appserver service.";
const COMPOSER_TOOL_DESCRIPTION = "Run Composer inside the appserver service.";
const PHP_TOOL_DESCRIPTION = "Run the PHP CLI inside the appserver service.";
export const backdropSnapshot: RecipeSnapshot = {
  identity: backdropProducer,
  optionTypes: {
    php: { kind: "enum", values: [...PHP_VERSIONS] },
    database: { kind: "enum", values: ["mariadb:11.4", "mysql:8.0"] },
    composer: { kind: "enum", values: ["2", "2.7.7", "false"] },
    webroot: { kind: "string", pattern: WEBROOT_PATTERN.source },
  },
  defaults: backdropDefaults,
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
              ["framework", lit("backdrop")],
              ["webroot", lit("{{ recipe.webroot }}")],
              ["composer", cond(composerEnabled(), lit("{{ recipe.composer }}"), lit(false))],
              ["allowOverride", lit(true)],
              ["port", lit(80)],
              ["dependsOn", arr(lit("database"))],
              ["routes", arr(defaultRoute())],
              ["environment", obj([["BACKDROP_SETTINGS", encodedStringNode(BACKDROP_SETTINGS_VALUE)]])],
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
            ["bee", toolNode("appserver", BEE_TOOL_DESCRIPTION, "bee")],
            ["composer", toolNode("appserver", COMPOSER_TOOL_DESCRIPTION, "composer")],
            ["php", toolNode("appserver", PHP_TOOL_DESCRIPTION, "php")],
          ]),
          obj([
            ["bee", toolNode("appserver", BEE_TOOL_DESCRIPTION, "bee")],
            ["php", toolNode("appserver", PHP_TOOL_DESCRIPTION, "php")],
          ]),
        ),
      ],
    ]),
  },
  assets: [],
};
export const backdropSnapshotYaml = recipeSnapshotYaml(backdropSnapshot);
