import type { RecipeSource } from "@lando/sdk/schema";
import { DRUSH_TOOLING_COMMAND } from "../drush-command.ts";
import { composerTool, drupalOptions, drupalWebVariants, phpAppserver } from "../source-php.ts";
import { DRUPAL_CMS_GIT_ARTIFACT, DRUPAL_CMS_SCAFFOLD_COMMAND, drupalCmsInstallCommand } from "./commands.ts";
import { DRUPAL_CMS_PHP_INI_PATH, DRUPAL_CMS_PHP_INI_TARGET } from "./php-config.ts";

export const source = {
  id: "drupal-cms",
  title: "Drupal CMS",
  description: "Drupal CMS with PHP, a database, and project-local Drush.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["drupal", "drupal-cms", "php", "mariadb"],
  options: drupalOptions,
  config: {
    runtime: 4,
    services: {
      appserver: {
        ...phpAppserver("drupal"),
        mounts: [
          { source: `./${DRUPAL_CMS_PHP_INI_PATH}`, target: DRUPAL_CMS_PHP_INI_TARGET, readOnly: true },
        ],
        build: { artifact: [DRUPAL_CMS_GIT_ARTIFACT] },
      },
      database: { type: "{{ recipe.database }}", database: "{{ app.name }}" },
    },
    tooling: {
      drush: {
        service: "appserver",
        description: "Run Drush inside the appserver service.",
        cmds: [DRUSH_TOOLING_COMMAND],
      },
      composer: composerTool,
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
        cmd: drupalCmsInstallCommand("mysql", "{{ app.name }}"),
      },
    },
  },
  variants: [
    ...drupalWebVariants,
    {
      when: '{{ eq(options.database, "postgres:16") }}',
      config: {
        tooling: { "drupal-cms-install": { cmd: drupalCmsInstallCommand("pgsql", "{{ app.name }}") } },
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
