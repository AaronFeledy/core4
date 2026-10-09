import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { DRUSH_TOOLING_COMMAND } from "../drush-command.ts";
import { phpSiteSnapshotBuilders } from "../php-site-snapshot.ts";
import { PHP_DEFAULT, PHP_VERSIONS } from "../php-stack.ts";
import { recipeAssetDigest } from "../snapshot-asset.ts";
import { arr, call, cond, encodedStringNode, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { DRUPAL_CMS_GIT_ARTIFACT, DRUPAL_CMS_SCAFFOLD_COMMAND, drupalCmsInstallCommand } from "./commands.ts";
import { DRUPAL_CMS_PHP_INI, DRUPAL_CMS_PHP_INI_PATH, DRUPAL_CMS_PHP_INI_TARGET } from "./php-config";

export const DRUPAL_CMS_RECIPE_VERSION = "0.1.0";
export const DRUPAL_CMS_CONTENT_DIGEST =
  "sha256:f70eda0fba125313bf013202bb05b7a3b0fe1fe28d72194c52139371960d4511";
export const drupalCmsProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-drupal-cms",
  recipeId: "drupal-cms",
  manifestVersion: DRUPAL_CMS_RECIPE_VERSION,
  contentDigest: DRUPAL_CMS_CONTENT_DIGEST,
};
export const drupalCmsDefaults = {
  php: PHP_DEFAULT,
  webserver: "apache",
  database: "mariadb:11.4",
  composer: "2",
  webroot: "/app/web",
} as const;
/** The one PostgreSQL member of the declared database domain. */
export const DRUPAL_CMS_POSTGRES_DATABASE = "postgres:16";
/** Install commands defer the app name to the Landofile app scope. */
export const DRUPAL_CMS_MYSQL_INSTALL_COMMAND = drupalCmsInstallCommand("mysql", "{{ app.name }}");
export const DRUPAL_CMS_PGSQL_INSTALL_COMMAND = drupalCmsInstallCommand("pgsql", "{{ app.name }}");
const usesPostgres = (): ExpressionNode =>
  call(
    "eq",
    { kind: "Path", head: "options", segments: [{ type: "prop", name: "database" }] },
    lit(DRUPAL_CMS_POSTGRES_DATABASE),
  );
const { usesNginx, databaseService, apacheAppserver, fpmAppserver, edgeService } = phpSiteSnapshotBuilders({
  framework: "drupal",
  databaseFields: [["database", lit("{{ app.name }}")]],
  appserverMounts: () =>
    arr(
      obj([
        ["source", lit(`./${DRUPAL_CMS_PHP_INI_PATH}`)],
        ["target", lit(DRUPAL_CMS_PHP_INI_TARGET)],
        ["readOnly", lit(true)],
      ]),
    ),
  appserverBuild: () =>
    obj([
      [
        "artifact",
        arr(
          obj([
            ["run", lit(DRUPAL_CMS_GIT_ARTIFACT.run)],
            ["user", lit(DRUPAL_CMS_GIT_ARTIFACT.user)],
          ]),
        ),
      ],
    ]),
});
export const drupalCmsSnapshot: RecipeSnapshot = {
  identity: drupalCmsProducer,
  optionTypes: {
    php: { kind: "enum", values: [...PHP_VERSIONS] },
    webserver: { kind: "enum", values: ["apache", "nginx"] },
    database: { kind: "enum", values: ["mariadb:11.4", "mysql:8.0", "postgres:16"] },
    composer: { kind: "enum", values: ["2", "2.7.7"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
  },
  defaults: drupalCmsDefaults,
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
            "drupal-cms-scaffold",
            obj([
              ["service", lit("appserver")],
              [
                "description",
                lit("Scaffold Drupal CMS 2 and project-local Drush into the mounted app root."),
              ],
              ["arguments", lit(false)],
              ["cmd", encodedStringNode(DRUPAL_CMS_SCAFFOLD_COMMAND)],
            ]),
          ],
          [
            "drupal-cms-install",
            obj([
              ["service", lit("appserver")],
              ["description", lit("Install Drupal CMS 2 using the drupal_cms_starter recipe.")],
              ["arguments", lit(false)],
              [
                "cmd",
                cond(
                  usesPostgres(),
                  encodedStringNode(DRUPAL_CMS_PGSQL_INSTALL_COMMAND),
                  encodedStringNode(DRUPAL_CMS_MYSQL_INSTALL_COMMAND),
                ),
              ],
            ]),
          ],
        ]),
      ],
    ]),
  },
  assets: [{ dest: DRUPAL_CMS_PHP_INI_PATH, digest: recipeAssetDigest(DRUPAL_CMS_PHP_INI), template: false }],
};
export const drupalCmsSnapshotYaml = recipeSnapshotYaml(drupalCmsSnapshot);
