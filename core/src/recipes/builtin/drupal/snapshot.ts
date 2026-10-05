import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { DRUSH_TOOLING_COMMAND } from "../drush-command.ts";
import { phpSiteSnapshotBuilders } from "../php-site-snapshot.ts";
import { PHP_DEFAULT, PHP_VERSIONS } from "../php-stack.ts";
import { cond, encodedStringNode, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { drupalScaffoldCommand } from "./scaffold-command.ts";

export const DRUPAL_RECIPE_VERSION = "0.1.0";
export const DRUPAL_CONTENT_DIGEST =
  "sha256:734160ff120bb8f081eaae70643aa1562c5747375bb9c023da4aea72ccec3ea3";
export const drupalProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-drupal",
  recipeId: "drupal",
  manifestVersion: DRUPAL_RECIPE_VERSION,
  contentDigest: DRUPAL_CONTENT_DIGEST,
};
export const drupalDefaults = {
  drupal: "11",
  php: PHP_DEFAULT,
  webserver: "apache",
  database: "mariadb:11.4",
  composer: "2",
  webroot: "/app/web",
} as const;
/**
 * The scaffold tooling command defers its Drupal major version to the recipe
 * option scope, so one published command text serves every declared major.
 */
export const DRUPAL_SCAFFOLD_AUTHORING_COMMAND = drupalScaffoldCommand("{{ recipe.drupal }}");
const { usesNginx, databaseService, apacheAppserver, fpmAppserver, edgeService } = phpSiteSnapshotBuilders({
  framework: "drupal",
});
export const drupalSnapshot: RecipeSnapshot = {
  identity: drupalProducer,
  optionTypes: {
    drupal: { kind: "enum", values: ["11", "10"] },
    php: { kind: "enum", values: [...PHP_VERSIONS] },
    webserver: { kind: "enum", values: ["apache", "nginx"] },
    database: { kind: "enum", values: ["mariadb:11.4", "mysql:8.0", "postgres:16"] },
    composer: { kind: "enum", values: ["2", "2.7.7"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
  },
  defaults: drupalDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        cond(
          usesNginx(),
          obj([
            ["appserver", fpmAppserver()],
            ["edge", edgeService()],
            ["database", databaseService()],
          ]),
          obj([
            ["appserver", apacheAppserver()],
            ["database", databaseService()],
          ]),
        ),
      ],
      [
        "tooling",
        obj([
          [
            "drush",
            toolNode("appserver", "Run Drush inside the appserver service.", [
              encodedStringNode(DRUSH_TOOLING_COMMAND),
            ]),
          ],
          ["composer", toolNode("appserver", "Run Composer inside the appserver service.", "composer")],
          [
            "drupal-scaffold",
            obj([
              ["service", lit("appserver")],
              ["description", lit("Scaffold Drupal and project-local Drush into the mounted app root.")],
              ["arguments", lit(false)],
              ["cmd", encodedStringNode(DRUPAL_SCAFFOLD_AUTHORING_COMMAND)],
            ]),
          ],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const drupalSnapshotYaml = recipeSnapshotYaml(drupalSnapshot);
