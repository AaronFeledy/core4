import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const NEXTJS_RECIPE_VERSION = "0.1.0";
export const NEXTJS_CONTENT_DIGEST =
  "sha256:58a8c095d77b22d51563d16f4ea9828b22e6fece178bec6434c0f56594fd23bb";

export const nextjsProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-nextjs",
  recipeId: "nextjs",
  manifestVersion: NEXTJS_RECIPE_VERSION,
  contentDigest: NEXTJS_CONTENT_DIGEST,
};

export const nextjsDefaults = { node: "lts", database: "postgres", auth: "none" } as const;

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
    { key: "port", value: { kind: "Literal", value: 3000 } },
    {
      key: "environment",
      value: {
        kind: "ObjectLiteral",
        entries: [{ key: "NEXTAUTH_PROVIDER", value: { kind: "Literal", value: "{{ recipe.auth }}" } }],
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

export const nextjsSnapshot: RecipeSnapshot = {
  identity: nextjsProducer,
  optionTypes: {
    node: { kind: "enum", values: ["lts", "22"] },
    database: { kind: "enum", values: ["none", "postgres", "mariadb"] },
    auth: { kind: "enum", values: ["none", "nextauth", "clerk"] },
  },
  defaults: nextjsDefaults,
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
              { key: "next", value: tool("Run the Next.js CLI inside the web service.", "npx next") },
              { key: "npm", value: tool("Run npm inside the web service.", "npm") },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const nextjsSnapshotYaml = recipeSnapshotYaml(nextjsSnapshot);
