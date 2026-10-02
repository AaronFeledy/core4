import { DRUSH_TOOLING_COMMAND } from "../drush-command";
import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { DRUPAL_CMS_SCAFFOLD_COMMAND } from "./commands.ts";
import { DRUPAL_CMS_PHP_INI_PATH, DRUPAL_CMS_PHP_INI_TARGET } from "./php-config";
import {
  DRUPAL_CMS_MYSQL_INSTALL_COMMAND,
  DRUPAL_CMS_PGSQL_INSTALL_COMMAND,
  DRUPAL_CMS_POSTGRES_DATABASE,
  drupalCmsProducer,
  drupalCmsSnapshot,
} from "./snapshot.ts";

const primaryRoutes = [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }];

export const drupalCmsDecomposer = makeOptionBearingDecomposer({
  producer: drupalCmsProducer,
  displayName: "Drupal CMS",
  optionTypes: drupalCmsSnapshot.optionTypes,
  fragment: (input) => {
    const nginx = input.options.webserver === "nginx";
    const database = { type: "{{ recipe.database }}", database: "{{ app.name }}" };
    return {
      services: nginx
        ? {
            appserver: {
              type: "php:{{ recipe.php }}",
              primary: true,
              framework: "drupal",
              via: "fpm",
              webroot: "{{ recipe.webroot }}",
              composer: "{{ recipe.composer }}",
              dependsOn: ["database"],
              mounts: [
                {
                  source: `./${DRUPAL_CMS_PHP_INI_PATH}`,
                  target: DRUPAL_CMS_PHP_INI_TARGET,
                  readOnly: true,
                },
              ],
            },
            edge: {
              type: "nginx",
              backend: "appserver",
              webroot: "{{ recipe.webroot }}",
              routes: primaryRoutes,
            },
            database,
          }
        : {
            appserver: {
              type: "php:{{ recipe.php }}",
              primary: true,
              framework: "drupal",
              webroot: "{{ recipe.webroot }}",
              composer: "{{ recipe.composer }}",
              allowOverride: true,
              port: 80,
              dependsOn: ["database"],
              mounts: [
                {
                  source: `./${DRUPAL_CMS_PHP_INI_PATH}`,
                  target: DRUPAL_CMS_PHP_INI_TARGET,
                  readOnly: true,
                },
              ],
              routes: primaryRoutes,
            },
            database,
          },
      tooling: {
        drush: {
          service: "appserver",
          description: "Run Drush inside the appserver service.",
          cmds: [DRUSH_TOOLING_COMMAND],
        },
        composer: {
          service: "appserver",
          description: "Run Composer inside the appserver service.",
          cmds: ["composer"],
        },
        "drupal-cms-scaffold": {
          service: "appserver",
          description: "Scaffold Drupal CMS 2 and project-local Drush into the mounted app root.",
          arguments: false,
          cmd: DRUPAL_CMS_SCAFFOLD_COMMAND,
        },
        "drupal-cms-install": {
          service: "appserver",
          description: "Install Drupal CMS 2 using the drupal_cms_starter recipe.",
          arguments: false,
          cmd:
            input.options.database === DRUPAL_CMS_POSTGRES_DATABASE
              ? DRUPAL_CMS_PGSQL_INSTALL_COMMAND
              : DRUPAL_CMS_MYSQL_INSTALL_COMMAND,
        },
      },
    };
  },
});
