import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const SYMFONY_RECIPE_VERSION = "0.1.0";
export const SYMFONY_CONTENT_DIGEST =
  "sha256:0785960e2af23b26a21686c55e449bc050663e4e9901b375eaf8e94830beb4f8";

export const symfonyProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-symfony",
  recipeId: "symfony",
  manifestVersion: SYMFONY_RECIPE_VERSION,
  contentDigest: SYMFONY_CONTENT_DIGEST,
};

export const symfonyDefaults = {
  php: "8.3",
  database: "postgres:16",
  composer: "2",
  webroot: "/app/public",
} as const;

// Snapshot input budgeting rejects a repeated object reference as a cycle, so
// every shared subtree is rebuilt per use rather than aliased.
const composerEnabled = (): ExpressionNode => ({
  kind: "Call",
  callee: "ne",
  args: [
    { kind: "Path", head: "options", segments: [{ type: "prop", name: "composer" }] },
    { kind: "Literal", value: "false" },
  ],
});
const consoleTool = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "appserver" } },
    {
      key: "description",
      value: { kind: "Literal", value: "Run the Symfony console inside the appserver service." },
    },
    {
      key: "cmds",
      value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "php bin/console" }] },
    },
  ],
});
const composerTool = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "appserver" } },
    { key: "description", value: { kind: "Literal", value: "Run Composer inside the appserver service." } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "composer" }] } },
  ],
});

export const symfonySnapshot: RecipeSnapshot = {
  identity: symfonyProducer,
  optionTypes: {
    php: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5"] },
    database: { kind: "enum", values: ["postgres:16", "mariadb:11.4"] },
    composer: { kind: "enum", values: ["2", "2.7.7"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
  },
  defaults: symfonyDefaults,
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
                    { key: "framework", value: { kind: "Literal", value: "symfony" } },
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
                      value: {
                        kind: "ArrayLiteral",
                        elements: [
                          { kind: "Literal", value: "database" },
                          { kind: "Literal", value: "cache" },
                        ],
                      },
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
              {
                key: "cache",
                value: {
                  kind: "ObjectLiteral",
                  entries: [{ key: "type", value: { kind: "Literal", value: "redis" } }],
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
                { key: "console", value: consoleTool() },
                { key: "composer", value: composerTool() },
              ],
            },
            alternate: { kind: "ObjectLiteral", entries: [{ key: "console", value: consoleTool() }] },
          },
        },
      ],
    },
  },
  assets: [],
};

export const symfonySnapshotYaml = recipeSnapshotYaml(symfonySnapshot);
