import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const ELEVENTY_RECIPE_VERSION = "0.1.0";
export const ELEVENTY_CONTENT_DIGEST =
  "sha256:89591241116d13890e347502e7e25c2a9ace413e695cb217728602466ec7ace1";

export const eleventyProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-eleventy",
  recipeId: "eleventy",
  manifestVersion: ELEVENTY_RECIPE_VERSION,
  contentDigest: ELEVENTY_CONTENT_DIGEST,
};

export const eleventyDefaults = {} as const;

const tool = (description: string, command: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "builder" } },
    { key: "description", value: { kind: "Literal", value: description } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: command }] } },
  ],
});

export const eleventySnapshot: RecipeSnapshot = {
  identity: eleventyProducer,
  optionTypes: {},
  defaults: eleventyDefaults,
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
                      value: { kind: "Literal", value: "npx @11ty/eleventy --serve --port 8080" },
                    },
                    { key: "port", value: { kind: "Literal", value: 8080 } },
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
              {
                key: "eleventy",
                value: tool("Run the Eleventy CLI inside the builder service.", "npx @11ty/eleventy"),
              },
              { key: "npm", value: tool("Run npm inside the builder service.", "npm") },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const eleventySnapshotYaml = recipeSnapshotYaml(eleventySnapshot);
