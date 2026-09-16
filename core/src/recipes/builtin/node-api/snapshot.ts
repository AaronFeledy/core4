import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const NODE_API_RECIPE_VERSION = "0.1.0";
export const NODE_API_CONTENT_DIGEST =
  "sha256:626bd72893e7a7a7497203b980754e9a4ba7d0dee5a3e1beb29ab6cf84cc1062";

export const nodeApiProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-node-api",
  recipeId: "node-api",
  manifestVersion: NODE_API_RECIPE_VERSION,
  contentDigest: NODE_API_CONTENT_DIGEST,
};

export const nodeApiDefaults = { node: "lts", framework: "express", database: "postgres" } as const;

const databaseEnabled = (): ExpressionNode => ({
  kind: "Call",
  callee: "ne",
  args: [
    { kind: "Path", head: "options", segments: [{ type: "prop", name: "database" }] },
    { kind: "Literal", value: "none" },
  ],
});

const apiService = (hasDatabase: boolean): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "type", value: { kind: "Literal", value: "node:{{ recipe.node }}" } },
    { key: "port", value: { kind: "Literal", value: 3000 } },
    {
      key: "environment",
      value: {
        kind: "ObjectLiteral",
        entries: [{ key: "API_FRAMEWORK", value: { kind: "Literal", value: "{{ recipe.framework }}" } }],
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

const api = (): ExpressionNode => ({
  kind: "Conditional",
  test: databaseEnabled(),
  consequent: apiService(true),
  alternate: apiService(false),
});

const tool = (description: string, command: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "api" } },
    { key: "description", value: { kind: "Literal", value: description } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: command }] } },
  ],
});

export const nodeApiSnapshot: RecipeSnapshot = {
  identity: nodeApiProducer,
  optionTypes: {
    node: { kind: "enum", values: ["lts", "22"] },
    framework: { kind: "enum", values: ["express", "fastify", "hono"] },
    database: { kind: "enum", values: ["postgres", "none"] },
  },
  defaults: nodeApiDefaults,
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
                { key: "api", value: api() },
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
              entries: [{ key: "api", value: api() }],
            },
          },
        },
        {
          key: "tooling",
          value: {
            kind: "ObjectLiteral",
            entries: [
              { key: "npm", value: tool("Run npm inside the api service.", "npm") },
              { key: "node", value: tool("Run Node inside the api service.", "node") },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const nodeApiSnapshotYaml = recipeSnapshotYaml(nodeApiSnapshot);
