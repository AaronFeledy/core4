import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { PHP_VERSIONS } from "../php-stack.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const JOOMLA_RECIPE_VERSION = "0.1.0";
export const JOOMLA_CONTENT_DIGEST =
  "sha256:5b7857528fdadc538a3f5fa03dfef698f04ed391f53cc7b40017f1cd7b340eda";

export const joomlaProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-joomla",
  recipeId: "joomla",
  manifestVersion: JOOMLA_RECIPE_VERSION,
  contentDigest: JOOMLA_CONTENT_DIGEST,
};

export const joomlaDefaults = {
  php: "8.3",
  database: "mariadb:11.4",
  composer: "2",
  webroot: "/app",
} as const;

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

const JOOMLA_TOOL_DESCRIPTION = "Run the Joomla CLI inside the appserver service.";
const COMPOSER_TOOL_DESCRIPTION = "Run Composer inside the appserver service.";
const PHP_TOOL_DESCRIPTION = "Run the PHP CLI inside the appserver service.";

export const joomlaSnapshot: RecipeSnapshot = {
  identity: joomlaProducer,
  optionTypes: {
    php: { kind: "enum", values: [...PHP_VERSIONS] },
    database: { kind: "enum", values: ["mariadb:11.4", "mysql:8.0"] },
    composer: { kind: "enum", values: ["2", "2.7.7", "false"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
  },
  defaults: joomlaDefaults,
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
                    { key: "primary", value: { kind: "Literal", value: true } },
                    { key: "framework", value: { kind: "Literal", value: "joomla" } },
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
                { key: "joomla", value: tool(JOOMLA_TOOL_DESCRIPTION, "php cli/joomla.php") },
                { key: "composer", value: tool(COMPOSER_TOOL_DESCRIPTION, "composer") },
                { key: "php", value: tool(PHP_TOOL_DESCRIPTION, "php") },
              ],
            },
            alternate: {
              kind: "ObjectLiteral",
              entries: [
                { key: "joomla", value: tool(JOOMLA_TOOL_DESCRIPTION, "php cli/joomla.php") },
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

export const joomlaSnapshotYaml = recipeSnapshotYaml(joomlaSnapshot);
