import type { RecipeSource } from "@lando/sdk/schema";
import { DRUSH_TOOLING_COMMAND } from "../drush-command.ts";
import {
  PHPCBF_TOOLING_COMMAND,
  PHPCS_TOOLING_COMMAND,
  PHPSTAN_TOOLING_COMMAND,
} from "../php-quality-command.ts";
import {
  composerTool,
  drupalOptions,
  drupalWebVariants,
  phpAppserver,
  phpcbfTool,
  phpcsTool,
  phpstanTool,
} from "../source-php.ts";

export const source = {
  id: "drupal",
  title: "Drupal",
  description: "Drupal with PHP, a database, and project-local Drush.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["drupal", "php", "mariadb"],
  options: {
    drupal: {
      type: { kind: "enum", values: ["11", "10"] },
      default: "11",
      prompt: { message: "Drupal major version" },
    },
    ...drupalOptions,
  },
  config: {
    runtime: 4,
    services: { appserver: phpAppserver("drupal"), database: { type: "{{ recipe.database }}" } },
    tooling: {
      drush: {
        service: "appserver",
        description: "Run Drush inside the appserver service.",
        cmds: [DRUSH_TOOLING_COMMAND],
        wrapper: true,
      },
      composer: composerTool,
      phpcs: { ...phpcsTool, cmds: [PHPCS_TOOLING_COMMAND] },
      phpcbf: { ...phpcbfTool, cmds: [PHPCBF_TOOLING_COMMAND] },
      phpstan: { ...phpstanTool, cmds: [PHPSTAN_TOOLING_COMMAND] },
      "drupal-scaffold": {
        service: "appserver",
        description: "Scaffold Drupal and project-local Drush into the mounted app root.",
        arguments: false,
        cmd: "lando-drupal-scaffold {{ recipe.drupal }}",
      },
    },
  },
  variants: drupalWebVariants,
  postInit: [
    {
      type: "message",
      text: "Run 'lando start', then scaffold Drupal and project-local Drush with 'lando drupal-scaffold'.",
    },
  ],
} as const satisfies RecipeSource;
