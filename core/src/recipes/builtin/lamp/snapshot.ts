import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const LAMP_RECIPE_VERSION = "0.1.0";
export const LAMP_CONTENT_DIGEST = "sha256:c0b2cde89f016351b3fd769068969460e7ebdcc01853ff6e61381f1290853fd8";
export const lampProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-lamp",
  recipeId: "lamp",
  manifestVersion: LAMP_RECIPE_VERSION,
  contentDigest: LAMP_CONTENT_DIGEST,
};

export const lampDefaults = {
  php: "8.3",
  database: "mariadb:11.4",
  composer: "2",
  webroot: "/app",
} as const;

const composerEnabled: ExpressionNode = {
  kind: "Call",
  callee: "ne",
  args: [
    { kind: "Path", head: "options", segments: [{ type: "prop", name: "composer" }] },
    { kind: "Literal", value: "false" },
  ],
};
const phpTool: ExpressionNode = {
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "appserver" } },
    {
      key: "description",
      value: { kind: "Literal", value: "Run the PHP CLI inside the appserver service." },
    },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "php" }] } },
  ],
};
const composerTool: ExpressionNode = {
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "appserver" } },
    { key: "description", value: { kind: "Literal", value: "Run Composer inside the appserver service." } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "composer" }] } },
  ],
};

export const lampSnapshot: RecipeSnapshot = {
  identity: lampProducer,
  optionTypes: {
    php: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5"] },
    database: { kind: "enum", values: ["mariadb:11.4", "mariadb:10.11", "mysql:8.0"] },
    composer: { kind: "enum", values: ["2", "2.7.7", "false"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
  },
  defaults: lampDefaults,
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
                    { key: "framework", value: { kind: "Literal", value: "none" } },
                    { key: "webroot", value: { kind: "Literal", value: "{{ recipe.webroot }}" } },
                    {
                      key: "composer",
                      value: {
                        kind: "Conditional",
                        test: composerEnabled,
                        consequent: { kind: "Literal", value: "{{ recipe.composer }}" },
                        alternate: { kind: "Literal", value: false },
                      },
                    },
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
                                value: { kind: "Literal", value: "{{ app.name }}.{{ proxy.defaultDomain }}" },
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
            test: {
              kind: "Call",
              callee: "ne",
              args: [
                { kind: "Path", head: "options", segments: [{ type: "prop", name: "composer" }] },
                { kind: "Literal", value: "false" },
              ],
            },
            consequent: {
              kind: "ObjectLiteral",
              entries: [
                { key: "composer", value: composerTool },
                { key: "php", value: phpTool },
              ],
            },
            alternate: {
              kind: "ObjectLiteral",
              entries: [
                {
                  key: "php",
                  value: {
                    kind: "ObjectLiteral",
                    entries: [
                      { key: "service", value: { kind: "Literal", value: "appserver" } },
                      {
                        key: "description",
                        value: { kind: "Literal", value: "Run the PHP CLI inside the appserver service." },
                      },
                      {
                        key: "cmds",
                        value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "php" }] },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    },
  },
  assets: [],
};

export const lampSnapshotYaml = recipeSnapshotYaml(lampSnapshot);
