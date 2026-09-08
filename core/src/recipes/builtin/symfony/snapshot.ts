import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const SYMFONY_RECIPE_VERSION = "0.1.0";
export const SYMFONY_CONTENT_DIGEST =
  "sha256:33e8ad026b3af1796cd2add9570befe9c6b36c8903354f2b34fd64d9b3d95ec0";

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
                    { key: "composer", value: { kind: "Literal", value: "{{ recipe.composer }}" } },
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
            kind: "ObjectLiteral",
            entries: [
              { key: "console", value: consoleTool() },
              { key: "composer", value: composerTool() },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const symfonySnapshotYaml = recipeSnapshotYaml(symfonySnapshot);
