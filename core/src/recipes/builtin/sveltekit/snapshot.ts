import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const SVELTEKIT_RECIPE_VERSION = "0.1.0";
export const SVELTEKIT_CONTENT_DIGEST =
  "sha256:f8a23c071d0f1b1528573a6514c9927ab5f2a64a286be3d5a7e58f9c5bfec469";

export const sveltekitProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-sveltekit",
  recipeId: "sveltekit",
  manifestVersion: SVELTEKIT_RECIPE_VERSION,
  contentDigest: SVELTEKIT_CONTENT_DIGEST,
};

export const sveltekitDefaults = { node: "lts", adapter: "node", database: "none" } as const;

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
    { key: "port", value: { kind: "Literal", value: 5173 } },
    {
      key: "environment",
      value: {
        kind: "ObjectLiteral",
        entries: [{ key: "SVELTEKIT_ADAPTER", value: { kind: "Literal", value: "{{ recipe.adapter }}" } }],
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

export const sveltekitSnapshot: RecipeSnapshot = {
  identity: sveltekitProducer,
  optionTypes: {
    node: { kind: "enum", values: ["lts", "22"] },
    adapter: { kind: "enum", values: ["node", "auto"] },
    database: { kind: "enum", values: ["none", "postgres", "mariadb"] },
  },
  defaults: sveltekitDefaults,
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
              {
                key: "svelte",
                value: tool("Run the Svelte CLI inside the web service.", "npx svelte-kit"),
              },
              { key: "npm", value: tool("Run npm inside the web service.", "npm") },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const sveltekitSnapshotYaml = recipeSnapshotYaml(sveltekitSnapshot);
