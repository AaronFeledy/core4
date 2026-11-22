import type { RecipeSource } from "@lando/sdk/schema";
import { drupalDatabaseUrl, drupalSiteTestingVariants } from "../drupal-testing.ts";
import { siteDrush, siteQualityTooling } from "../drupal-tooling.ts";
import { composerTool, drupalSiteOptions, drupalWebVariants, phpAppserver } from "../source-php.ts";
import { DRUPAL_CMS_GIT_ARTIFACT, drupalCmsInstallCommand } from "./commands.ts";
import { DRUPAL_CMS_PHP_INI_PATH, DRUPAL_CMS_PHP_INI_TARGET } from "./php-config.ts";

const scaffold = (testing: boolean) => ({
  tooling: {
    "drupal-cms-scaffold": {
      service: "appserver",
      description: "Scaffold Drupal CMS 2 and project-local Drush into the mounted app root.",
      arguments: false,
      cmd: `lando-drupal-cms-scaffold "$LANDO_WEBROOT" --testing=${testing}`,
    },
  },
});

export const source = {
  id: "drupal-cms",
  title: "Drupal CMS",
  description: "Drupal CMS with PHP, a database, and project-local Drush.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["drupal", "drupal-cms", "php", "mariadb"],
  options: drupalSiteOptions,
  config: {
    runtime: 4,
    services: {
      appserver: {
        ...phpAppserver("drupal"),
        environment: { LANDO_DRUPAL_CMS_DB_URL: drupalDatabaseUrl("mysql") },
        mounts: [
          { source: `./${DRUPAL_CMS_PHP_INI_PATH}`, target: DRUPAL_CMS_PHP_INI_TARGET, readOnly: true },
        ],
        build: { artifact: [DRUPAL_CMS_GIT_ARTIFACT] },
      },
      database: { type: "{{ recipe.database }}" },
    },
    tooling: {
      drush: siteDrush,
      composer: composerTool,
      ...siteQualityTooling,
      ...scaffold(false).tooling,
      "drupal-cms-install": {
        service: "appserver",
        dir: "/app",
        description: "Install Drupal CMS 2 using the drupal_cms_starter recipe.",
        arguments: false,
        cmd: drupalCmsInstallCommand,
      },
    },
  },
  variants: [
    ...drupalWebVariants,
    ...drupalSiteTestingVariants([{ when: "{{ options.testing }}", config: scaffold(true) }]),
    {
      when: '{{ eq(options.database, "postgres:16") }}',
      config: {
        services: { appserver: { environment: { LANDO_DRUPAL_CMS_DB_URL: drupalDatabaseUrl("pgsql") } } },
      },
    },
  ],
  files: [{ src: "assets/drupal-cms.ini", dest: DRUPAL_CMS_PHP_INI_PATH, template: false }],
  postInit: [
    {
      type: "message",
      text: "Run 'lando start', then scaffold Drupal CMS with 'lando drupal-cms-scaffold', then install with 'lando drupal-cms-install'.",
    },
  ],
} as const satisfies RecipeSource;
