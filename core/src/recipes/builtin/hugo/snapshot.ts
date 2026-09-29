import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const HUGO_RECIPE_VERSION = "0.1.0";
export const HUGO_CONTENT_DIGEST = "sha256:297c9145943a2e7d49d15ea186ee704d3d95d2d269256391311d53bf3f857c81";

export const hugoProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-hugo",
  recipeId: "hugo",
  manifestVersion: HUGO_RECIPE_VERSION,
  contentDigest: HUGO_CONTENT_DIGEST,
};

export const hugoDefaults = {} as const;

const tool = (description: string, command: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "builder" } },
    { key: "description", value: { kind: "Literal", value: description } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: command }] } },
  ],
});

export const hugoSnapshot: RecipeSnapshot = {
  identity: hugoProducer,
  optionTypes: {},
  defaults: hugoDefaults,
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
                key: "builder",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    { key: "type", value: { kind: "Literal", value: "node:lts" } },
                    { key: "primary", value: { kind: "Literal", value: true } },
                    {
                      key: "command",
                      value: { kind: "Literal", value: "npx hugo server --bind 0.0.0.0 --port 1313" },
                    },
                    { key: "port", value: { kind: "Literal", value: 1313 } },
                  ],
                },
              },
              {
                key: "web",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    { key: "type", value: { kind: "Literal", value: "static:nginx" } },
                    { key: "primary", value: { kind: "Literal", value: false } },
                    {
                      key: "appMount",
                      value: {
                        kind: "ObjectLiteral",
                        entries: [{ key: "target", value: { kind: "Literal", value: "/app" } }],
                      },
                    },
                    { key: "webroot", value: { kind: "Literal", value: "/app/public" } },
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
            ],
          },
        },
        {
          key: "tooling",
          value: {
            kind: "ObjectLiteral",
            entries: [
              { key: "hugo", value: tool("Run the Hugo CLI inside the builder service.", "npx hugo") },
              { key: "npm", value: tool("Run npm inside the builder service.", "npm") },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const hugoSnapshotYaml = recipeSnapshotYaml(hugoSnapshot);
