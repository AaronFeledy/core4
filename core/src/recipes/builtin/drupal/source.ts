import type { RecipeSource } from "@lando/sdk/schema";
import { drupalSiteTestingVariants } from "../drupal-testing.ts";
import { siteDrush, siteQualityTooling } from "../drupal-tooling.ts";
import { composerTool, drupalSiteOptions, drupalWebVariants, phpAppserver } from "../source-php.ts";

const majors = ["11", "10"] as const;

const scaffold = (major: (typeof majors)[number], testing: boolean) => ({
  services: {
    appserver: {
      build: {
        app: [
          {
            run: `lando-drupal-scaffold ${major} "$LANDO_WEBROOT" --testing=${testing}`,
          },
        ],
      },
    },
  },
});

export const source = {
  id: "drupal",
  title: "Drupal",
  description: "Drupal with PHP, a database, and project-local Drush.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["drupal", "php", "mariadb"],
  options: {
    drupal: {
      type: { kind: "enum", values: majors },
      default: "11",
      prompt: { message: "Drupal major version" },
    },
    ...drupalSiteOptions,
  },
  config: {
    runtime: 4,
    services: {
      appserver: {
        ...phpAppserver("drupal"),
        ...scaffold("11", false).services.appserver,
      },
      database: { type: "{{ recipe.database }}" },
    },
    tooling: {
      drush: siteDrush,
      composer: composerTool,
      ...siteQualityTooling,
    },
  },
  variants: [
    ...drupalWebVariants,
    { when: '{{ eq(options.drupal, "10") }}', config: scaffold("10", false) },
    ...drupalSiteTestingVariants,
    ...majors.map((major) => ({
      when: `{{ and(options.testing, eq(options.drupal, "${major}")) }}`,
      config: scaffold(major, true),
    })),
  ],
  postInit: [
    {
      type: "message",
      text: "Run 'lando start' to start the stack and scaffold Drupal with project-local Drush.",
    },
  ],
} as const satisfies RecipeSource;
