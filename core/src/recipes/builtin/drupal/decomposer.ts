import { DRUSH_TOOLING_COMMAND } from "../drush-command";
import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { DRUPAL_SCAFFOLD_AUTHORING_COMMAND, drupalProducer, drupalSnapshot } from "./snapshot.ts";

const primaryRoutes = [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }];

export const drupalDecomposer = makeOptionBearingDecomposer({
  producer: drupalProducer,
  displayName: "Drupal",
  optionTypes: drupalSnapshot.optionTypes,
  fragment: (input) => {
    const nginx = input.options.webserver === "nginx";
    const database = { type: "{{ recipe.database }}" };
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
        "drupal-scaffold": {
          service: "appserver",
          description: "Scaffold Drupal and project-local Drush into the mounted app root.",
          arguments: false,
          cmd: DRUPAL_SCAFFOLD_AUTHORING_COMMAND,
        },
      },
    };
  },
});
