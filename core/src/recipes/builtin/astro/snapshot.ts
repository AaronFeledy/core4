import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const ASTRO_RECIPE_VERSION = "0.1.0";
export const ASTRO_CONTENT_DIGEST = "sha256:21ce77c9cfc6e2fca11be251ad29107346b07d2404817c5eaab596d54f933636";

export const astroProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-astro",
  recipeId: "astro",
  manifestVersion: ASTRO_RECIPE_VERSION,
  contentDigest: ASTRO_CONTENT_DIGEST,
};

export const astroDefaults = { node: "lts", database: "none" } as const;

const databaseEnabled = (): ExpressionNode => ({
  kind: "Call",
  callee: "ne",
  args: [
    { kind: "Path", head: "options", segments: [{ type: "prop", name: "database" }] },
    { kind: "Literal", value: "none" },
  ],
});

const webService = (hasDatabase: boolean): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "type", value: { kind: "Literal", value: "node:{{ recipe.node }}" } },
    { key: "port", value: { kind: "Literal", value: 4321 } },
    {
      key: "environment",
      value: {
        kind: "ObjectLiteral",
        entries: [{ key: "ASTRO_TELEMETRY_DISABLED", value: { kind: "Literal", value: "1" } }],
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
    ...(hasDatabase
      ? [
          {
            key: "dependsOn",
            value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "database" }] },
          } satisfies { readonly key: string; readonly value: ExpressionNode },
        ]
      : []),
  ],
});

const web = (): ExpressionNode => ({
  kind: "Conditional",
  test: databaseEnabled(),
  consequent: webService(true),
  alternate: webService(false),
});

const tool = (description: string, command: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "web" } },
    { key: "description", value: { kind: "Literal", value: description } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: command }] } },
  ],
});

export const astroSnapshot: RecipeSnapshot = {
  identity: astroProducer,
  optionTypes: {
    node: { kind: "enum", values: ["lts", "22"] },
    database: { kind: "enum", values: ["none", "postgres", "mariadb"] },
  },
  defaults: astroDefaults,
  template: {
    expression: {
      kind: "ObjectLiteral",
      entries: [
        { key: "runtime", value: { kind: "Literal", value: 4 } },
        {
          key: "services",
          value: {
            kind: "Conditional",
            test: databaseEnabled(),
            consequent: {
              kind: "ObjectLiteral",
              entries: [
                { key: "web", value: web() },
                {
                  key: "database",
                  value: {
                    kind: "ObjectLiteral",
                    entries: [{ key: "type", value: { kind: "Literal", value: "{{ recipe.database }}" } }],
                  },
                },
              ],
            },
            alternate: {
              kind: "ObjectLiteral",
              entries: [{ key: "web", value: web() }],
            },
          },
        },
        {
          key: "tooling",
          value: {
            kind: "ObjectLiteral",
            entries: [
              { key: "astro", value: tool("Run the Astro CLI inside the web service.", "npx astro") },
              { key: "npm", value: tool("Run npm inside the web service.", "npm") },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const astroSnapshotYaml = recipeSnapshotYaml(astroSnapshot);
