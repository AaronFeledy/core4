import type { RecipeSource } from "@lando/sdk/schema";
import { drupalSiteTestingVariants } from "../drupal-testing.ts";
import { siteDrush, siteQualityTooling } from "../drupal-tooling.ts";
import { composerTool, drupalSiteOptions, drupalWebVariants, phpAppserver } from "../source-php.ts";

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
    ...drupalSiteOptions,
  },
  config: {
    runtime: 4,
    services: { appserver: phpAppserver("drupal"), database: { type: "{{ recipe.database }}" } },
    tooling: {
      drush: siteDrush,
      composer: composerTool,
      ...siteQualityTooling,
      "drupal-scaffold": {
        service: "appserver",
        description: "Scaffold Drupal and project-local Drush into the mounted app root.",
        arguments: false,
        cmd: [
          "lando-drupal-scaffold",
          "{{ recipe.drupal }}",
          "{{ recipe.webroot }}",
          "--testing={{ recipe.testing }}",
        ],
      },
    },
  },
  variants: [...drupalWebVariants, ...drupalSiteTestingVariants],
  postInit: [
    {
      type: "message",
      text: "Run 'lando start', then scaffold Drupal and project-local Drush with 'lando drupal-scaffold'.",
    },
  ],
} as const satisfies RecipeSource;
