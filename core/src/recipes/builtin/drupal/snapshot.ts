import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { encodedStringNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { drupalScaffoldCommand } from "./scaffold-command.ts";

export const DRUPAL_RECIPE_VERSION = "0.1.0";
export const DRUPAL_CONTENT_DIGEST =
  "sha256:e19e6e75cb31520601c5c648cd19ee2378a6a05593d42120ed2fcbae91ab8e81";

export const drupalProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-drupal",
  recipeId: "drupal",
  manifestVersion: DRUPAL_RECIPE_VERSION,
  contentDigest: DRUPAL_CONTENT_DIGEST,
};

export const drupalDefaults = {
  drupal: "11",
  php: "8.3",
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

const usesNginx = (): ExpressionNode => ({
  kind: "Call",
  callee: "eq",
  args: [
    { kind: "Path", head: "options", segments: [{ type: "prop", name: "webserver" }] },
    { kind: "Literal", value: "nginx" },
  ],
});

const primaryRoutes = (): ExpressionNode => ({
  kind: "ArrayLiteral",
  elements: [
    {
      kind: "ObjectLiteral",
      entries: [
        { key: "hostname", value: { kind: "Literal", value: "{{ app.name }}.{{ proxy.defaultDomain }}" } },
        { key: "scheme", value: { kind: "Literal", value: "both" } },
      ],
    },
  ],
});

const databaseService = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [{ key: "type", value: { kind: "Literal", value: "{{ recipe.database }}" } }],
});

const apacheAppserver = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "type", value: { kind: "Literal", value: "php:{{ recipe.php }}" } },
    { key: "framework", value: { kind: "Literal", value: "drupal" } },
    { key: "webroot", value: { kind: "Literal", value: "{{ recipe.webroot }}" } },
    { key: "composer", value: { kind: "Literal", value: "{{ recipe.composer }}" } },
    { key: "allowOverride", value: { kind: "Literal", value: true } },
    { key: "port", value: { kind: "Literal", value: 80 } },
    { key: "dependsOn", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "database" }] } },
    { key: "routes", value: primaryRoutes() },
  ],
});

const fpmAppserver = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "type", value: { kind: "Literal", value: "php:{{ recipe.php }}" } },
    { key: "framework", value: { kind: "Literal", value: "drupal" } },
    { key: "via", value: { kind: "Literal", value: "fpm" } },
    { key: "webroot", value: { kind: "Literal", value: "{{ recipe.webroot }}" } },
    { key: "composer", value: { kind: "Literal", value: "{{ recipe.composer }}" } },
    { key: "dependsOn", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "database" }] } },
  ],
});

const edgeService = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "type", value: { kind: "Literal", value: "nginx" } },
    { key: "backend", value: { kind: "Literal", value: "appserver" } },
    { key: "webroot", value: { kind: "Literal", value: "{{ recipe.webroot }}" } },
    { key: "routes", value: primaryRoutes() },
  ],
});

const tool = (description: string, command: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "appserver" } },
    { key: "description", value: { kind: "Literal", value: description } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: command }] } },
  ],
});

export const drupalSnapshot: RecipeSnapshot = {
  identity: drupalProducer,
  optionTypes: {
    drupal: { kind: "enum", values: ["11", "10"] },
    php: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5"] },
    webserver: { kind: "enum", values: ["apache", "nginx"] },
    database: { kind: "enum", values: ["mariadb:11.4", "mariadb:10.11", "mysql:8.0", "postgres:16"] },
    composer: { kind: "enum", values: ["2", "2.7.7"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
  },
  defaults: drupalDefaults,
  template: {
    expression: {
      kind: "ObjectLiteral",
      entries: [
        { key: "runtime", value: { kind: "Literal", value: 4 } },
        {
          key: "services",
          value: {
            kind: "Conditional",
            test: usesNginx(),
            consequent: {
              kind: "ObjectLiteral",
              entries: [
                { key: "appserver", value: fpmAppserver() },
                { key: "edge", value: edgeService() },
                { key: "database", value: databaseService() },
              ],
            },
            alternate: {
              kind: "ObjectLiteral",
              entries: [
                { key: "appserver", value: apacheAppserver() },
                { key: "database", value: databaseService() },
              ],
            },
          },
        },
        {
          key: "tooling",
          value: {
            kind: "ObjectLiteral",
            entries: [
              { key: "drush", value: tool("Run Drush inside the appserver service.", "vendor/bin/drush") },
              { key: "composer", value: tool("Run Composer inside the appserver service.", "composer") },
              {
                key: "drupal-scaffold",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    { key: "service", value: { kind: "Literal", value: "appserver" } },
                    {
                      key: "description",
                      value: {
                        kind: "Literal",
                        value: "Scaffold Drupal and project-local Drush into the mounted app root.",
                      },
                    },
                    { key: "arguments", value: { kind: "Literal", value: false } },
                    { key: "cmd", value: encodedStringNode(DRUPAL_SCAFFOLD_AUTHORING_COMMAND) },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const drupalSnapshotYaml = recipeSnapshotYaml(drupalSnapshot);
