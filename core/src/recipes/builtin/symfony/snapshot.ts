import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { PHP_DEFAULT, PHP_VERSIONS } from "../php-stack.ts";
import { arr, call, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const SYMFONY_RECIPE_VERSION = "0.1.0";
export const SYMFONY_CONTENT_DIGEST =
  "sha256:40915902ba0eb60926e169ad7da8e0c2d3c2f4330634ce908c5c197cac7a2e92";
export const symfonyProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-symfony",
  recipeId: "symfony",
  manifestVersion: SYMFONY_RECIPE_VERSION,
  contentDigest: SYMFONY_CONTENT_DIGEST,
};
export const symfonyDefaults = {
  php: PHP_DEFAULT,
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
              [
                "environment",
                obj([
                  [
                    "DATABASE_URL",
                    cond(
                      call(
                        "eq",
                        { kind: "Path", head: "options", segments: [{ type: "prop", name: "database" }] },
                        lit("mariadb:11.4"),
                      ),
                      lit(
                        "mysql://{{ services.database.creds.user }}:{{ services.database.creds.password }}@database:3306/{{ services.database.creds.database }}?serverVersion=11.4.0-MariaDB&charset=utf8mb4",
                      ),
                      lit(
                        "postgresql://{{ services.database.creds.user }}:{{ services.database.creds.password }}@database:5432/{{ services.database.creds.database }}?serverVersion=16&charset=utf8",
                      ),
                    ),
                  ],
                  ["REDIS_URL", lit("redis://cache:6379")],
                ]),
              ],
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
