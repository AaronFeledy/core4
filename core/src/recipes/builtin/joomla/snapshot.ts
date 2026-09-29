import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { PHP_VERSIONS } from "../php-stack.ts";
import { arr, call, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const JOOMLA_RECIPE_VERSION = "0.1.0";
export const JOOMLA_CONTENT_DIGEST =
  "sha256:5b7857528fdadc538a3f5fa03dfef698f04ed391f53cc7b40017f1cd7b340eda";
export const joomlaProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-joomla",
  recipeId: "joomla",
  manifestVersion: JOOMLA_RECIPE_VERSION,
  contentDigest: JOOMLA_CONTENT_DIGEST,
};
export const joomlaDefaults = {
  php: "8.3",
  database: "mariadb:11.4",
  composer: "2",
  webroot: "/app",
} as const;
const composerEnabled = (): ExpressionNode =>
  call("ne", { kind: "Path", head: "options", segments: [{ type: "prop", name: "composer" }] }, lit("false"));
const JOOMLA_TOOL_DESCRIPTION = "Run the Joomla CLI inside the appserver service.";
const COMPOSER_TOOL_DESCRIPTION = "Run Composer inside the appserver service.";
const PHP_TOOL_DESCRIPTION = "Run the PHP CLI inside the appserver service.";
export const joomlaSnapshot: RecipeSnapshot = {
  identity: joomlaProducer,
  optionTypes: {
    php: { kind: "enum", values: [...PHP_VERSIONS] },
    database: { kind: "enum", values: ["mariadb:11.4", "mysql:8.0"] },
    composer: { kind: "enum", values: ["2", "2.7.7", "false"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
  },
  defaults: joomlaDefaults,
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
              ["framework", lit("joomla")],
              ["webroot", lit("{{ recipe.webroot }}")],
              ["composer", cond(composerEnabled(), lit("{{ recipe.composer }}"), lit(false))],
              ["allowOverride", lit(true)],
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
            ["joomla", toolNode("appserver", JOOMLA_TOOL_DESCRIPTION, "php cli/joomla.php")],
            ["composer", toolNode("appserver", COMPOSER_TOOL_DESCRIPTION, "composer")],
            ["php", toolNode("appserver", PHP_TOOL_DESCRIPTION, "php")],
          ]),
          obj([
            ["joomla", toolNode("appserver", JOOMLA_TOOL_DESCRIPTION, "php cli/joomla.php")],
            ["php", toolNode("appserver", PHP_TOOL_DESCRIPTION, "php")],
          ]),
        ),
      ],
    ]),
  },
  assets: [],
};
export const joomlaSnapshotYaml = recipeSnapshotYaml(joomlaSnapshot);
