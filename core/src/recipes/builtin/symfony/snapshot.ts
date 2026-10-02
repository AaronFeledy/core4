import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { PHP_VERSIONS } from "../php-stack.ts";
import { arr, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const SYMFONY_RECIPE_VERSION = "0.1.0";
export const SYMFONY_CONTENT_DIGEST =
  "sha256:d4a8158703f560045773afc9f212b0d39a3ec2246bf79c72d598123193f42773";
export const symfonyProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-symfony",
  recipeId: "symfony",
  manifestVersion: SYMFONY_RECIPE_VERSION,
  contentDigest: SYMFONY_CONTENT_DIGEST,
};
export const symfonyDefaults = {
  php: "8.3",
  database: "postgres:16",
  composer: "2",
  webroot: "/app/public",
} as const;
export const symfonySnapshot: RecipeSnapshot = {
  identity: symfonyProducer,
  optionTypes: {
    php: { kind: "enum", values: [...PHP_VERSIONS] },
    database: { kind: "enum", values: ["postgres:16", "mariadb:11.4"] },
    composer: { kind: "enum", values: ["2", "2.7.7"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
  },
  defaults: symfonyDefaults,
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
              ["framework", lit("symfony")],
              ["webroot", lit("{{ recipe.webroot }}")],
              ["composer", lit("{{ recipe.composer }}")],
              ["allowOverride", lit(true)],
              ["port", lit(80)],
              ["dependsOn", arr(lit("database"), lit("cache"))],
              ["routes", arr(defaultRoute())],
            ]),
          ],
          ["database", obj([["type", lit("{{ recipe.database }}")]])],
          ["cache", obj([["type", lit("redis")]])],
        ]),
      ],
      [
        "tooling",
        obj([
          [
            "console",
            toolNode("appserver", "Run the Symfony console inside the appserver service.", "php bin/console"),
          ],
          ["composer", toolNode("appserver", "Run Composer inside the appserver service.", "composer")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const symfonySnapshotYaml = recipeSnapshotYaml(symfonySnapshot);
