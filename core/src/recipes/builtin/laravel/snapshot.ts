import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { PHP_VERSIONS } from "../php-stack.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const LARAVEL_RECIPE_VERSION = "0.1.0";
export const LARAVEL_CONTENT_DIGEST =
  "sha256:cad615b0881b6c614bb027104fc1980eef72f30aa6802e99207afee7928168b7";
export const laravelProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-laravel",
  recipeId: "laravel",
  manifestVersion: LARAVEL_RECIPE_VERSION,
  contentDigest: LARAVEL_CONTENT_DIGEST,
};

const artisanTool = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "appserver" } },
    {
      key: "description",
      value: { kind: "Literal", value: "Run a Laravel Artisan command inside the appserver service." },
    },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "php artisan" }] } },
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
const npmTool = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "appserver" } },
    { key: "description", value: { kind: "Literal", value: "Run npm inside the appserver service." } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "npm" }] } },
  ],
});

const expression: ExpressionNode = {
  kind: "ObjectLiteral",
  entries: [
    { key: "runtime", value: { kind: "Literal", value: 4 } },
    {
      key: "services",
      value: {
        kind: "Call",
        callee: "merge",
        args: [
          {
            kind: "ObjectLiteral",
            entries: [
              {
                key: "appserver",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    { key: "type", value: { kind: "Literal", value: "php:{{ recipe.php }}" } },
                    { key: "primary", value: { kind: "Literal", value: true } },
                    { key: "framework", value: { kind: "Literal", value: "laravel" } },
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
          {
            kind: "Conditional",
            test: {
              kind: "Call",
              callee: "eq",
              args: [
                { kind: "Path", head: "options", segments: [{ type: "prop", name: "worker" }] },
                { kind: "Literal", value: true },
              ],
            },
            consequent: {
              kind: "ObjectLiteral",
              entries: [
                {
                  key: "worker",
                  value: {
                    kind: "ObjectLiteral",
                    entries: [
                      { key: "type", value: { kind: "Literal", value: "php:{{ recipe.php }}" } },
                      { key: "framework", value: { kind: "Literal", value: "laravel" } },
                      { key: "via", value: { kind: "Literal", value: "cli" } },
                      { key: "command", value: { kind: "Literal", value: "php artisan queue:work" } },
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
                    ],
                  },
                },
              ],
            },
            alternate: { kind: "ObjectLiteral", entries: [] },
          },
        ],
      },
    },
    {
      key: "tooling",
      value: {
        kind: "ObjectLiteral",
        entries: [
          { key: "artisan", value: artisanTool() },
          { key: "composer", value: composerTool() },
          { key: "npm", value: npmTool() },
        ],
      },
    },
  ],
};

export const laravelSnapshot: RecipeSnapshot = {
  identity: laravelProducer,
  optionTypes: {
    php: { kind: "enum", values: [...PHP_VERSIONS] },
    database: { kind: "enum", values: ["mariadb:11.4", "postgres:16"] },
    composer: { kind: "enum", values: ["2", "2.7.7"] },
    webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
    worker: { kind: "boolean" },
  },
  defaults: { php: "8.3", database: "mariadb:11.4", composer: "2", webroot: "/app/public", worker: false },
  template: { expression },
  assets: [],
};
export const laravelSnapshotYaml = recipeSnapshotYaml(laravelSnapshot);
