import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { encodedStringNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { backdropSettings } from "./settings.ts";

export const BACKDROP_RECIPE_VERSION = "0.1.0";
export const BACKDROP_CONTENT_DIGEST =
  "sha256:a12bfc4006d9b2a3952d5d00d7f34ef6945f4ff290d1e46f57fb63b522c70b2c";

export const backdropProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-backdrop",
  recipeId: "backdrop",
  manifestVersion: BACKDROP_RECIPE_VERSION,
  contentDigest: BACKDROP_CONTENT_DIGEST,
};

export const backdropDefaults = {
  php: "8.3",
  database: "mariadb:11.4",
  composer: "2",
  webroot: "/app",
} as const;

/** Backdrop reads its database credentials from this app-scoped settings blob. */
export const BACKDROP_SETTINGS_VALUE = backdropSettings("{{ app.name }}");

const composerEnabled = (): ExpressionNode => ({
  kind: "Call",
  callee: "ne",
  args: [
    { kind: "Path", head: "options", segments: [{ type: "prop", name: "composer" }] },
    { kind: "Literal", value: "false" },
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

const BEE_TOOL_DESCRIPTION = "Run Bee inside the appserver service.";
const COMPOSER_TOOL_DESCRIPTION = "Run Composer inside the appserver service.";
const PHP_TOOL_DESCRIPTION = "Run the PHP CLI inside the appserver service.";

export const backdropSnapshot: RecipeSnapshot = {
  identity: backdropProducer,
  optionTypes: {
    php: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5"] },
    database: { kind: "enum", values: ["mariadb:11.4", "mariadb:10.11", "mysql:8.0"] },
    composer: { kind: "enum", values: ["2", "2.7.7", "false"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
  },
  defaults: backdropDefaults,
  template: {
    expression: {
      kind: "ObjectLiteral",
      entries: [
        { key: "runtime", value: { kind: "Literal", value: 4 } },
        {
          key: "services",
          value: {
            kind: "ObjectLiteral",
            entries: [
              {
                key: "appserver",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    { key: "type", value: { kind: "Literal", value: "php:{{ recipe.php }}" } },
                    { key: "framework", value: { kind: "Literal", value: "backdrop" } },
                    { key: "webroot", value: { kind: "Literal", value: "{{ recipe.webroot }}" } },
                    {
                      key: "composer",
                      value: {
                        kind: "Conditional",
                        test: composerEnabled(),
                        consequent: { kind: "Literal", value: "{{ recipe.composer }}" },
                        alternate: { kind: "Literal", value: false },
                      },
                    },
                    { key: "allowOverride", value: { kind: "Literal", value: true } },
                    { key: "port", value: { kind: "Literal", value: 80 } },
                    {
                      key: "dependsOn",
                      value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "database" }] },
                    },
                    {
                      key: "routes",
                      value: {
                        kind: "ArrayLiteral",
                        elements: [
                          {
                            kind: "ObjectLiteral",
                            entries: [
                              {
                                key: "hostname",
                                value: {
                                  kind: "Literal",
                                  value: "{{ app.name }}.{{ proxy.defaultDomain }}",
                                },
                              },
                              { key: "scheme", value: { kind: "Literal", value: "both" } },
                            ],
                          },
                        ],
                      },
                    },
                    {
                      key: "environment",
                      value: {
                        kind: "ObjectLiteral",
                        entries: [
                          { key: "BACKDROP_SETTINGS", value: encodedStringNode(BACKDROP_SETTINGS_VALUE) },
                        ],
                      },
                    },
                  ],
                },
              },
              {
                key: "database",
                value: {
                  kind: "ObjectLiteral",
                  entries: [{ key: "type", value: { kind: "Literal", value: "{{ recipe.database }}" } }],
                },
              },
            ],
          },
        },
        {
          key: "tooling",
          value: {
            kind: "Conditional",
            test: composerEnabled(),
            consequent: {
              kind: "ObjectLiteral",
              entries: [
                { key: "bee", value: tool(BEE_TOOL_DESCRIPTION, "bee") },
                { key: "composer", value: tool(COMPOSER_TOOL_DESCRIPTION, "composer") },
                { key: "php", value: tool(PHP_TOOL_DESCRIPTION, "php") },
              ],
            },
            alternate: {
              kind: "ObjectLiteral",
              entries: [
                { key: "bee", value: tool(BEE_TOOL_DESCRIPTION, "bee") },
                { key: "php", value: tool(PHP_TOOL_DESCRIPTION, "php") },
              ],
            },
          },
        },
      ],
    },
  },
  assets: [],
};

export const backdropSnapshotYaml = recipeSnapshotYaml(backdropSnapshot);
