import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const JEKYLL_RECIPE_VERSION = "0.1.0";
export const JEKYLL_CONTENT_DIGEST =
  "sha256:87bf65df2b9440752e42d6610d6fa1bdb69e669efa389b5d70b1238139420e64";

export const jekyllProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-jekyll",
  recipeId: "jekyll",
  manifestVersion: JEKYLL_RECIPE_VERSION,
  contentDigest: JEKYLL_CONTENT_DIGEST,
};

export const jekyllDefaults = {} as const;

const tool = (description: string, command: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "builder" } },
    { key: "description", value: { kind: "Literal", value: description } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: command }] } },
  ],
});

export const jekyllSnapshot: RecipeSnapshot = {
  identity: jekyllProducer,
  optionTypes: {},
  defaults: jekyllDefaults,
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
                    { key: "type", value: { kind: "Literal", value: "ruby:3.3" } },
                    { key: "framework", value: { kind: "Literal", value: "none" } },
                    {
                      key: "command",
                      value: {
                        kind: "Literal",
                        value: "bundle exec jekyll serve --host 0.0.0.0 --port 4000",
                      },
                    },
                    { key: "port", value: { kind: "Literal", value: 4000 } },
                  ],
                },
              },
              {
                key: "web",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    { key: "type", value: { kind: "Literal", value: "static:nginx" } },
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
                key: "jekyll",
                value: tool("Run the Jekyll CLI inside the builder service.", "bundle exec jekyll"),
              },
              { key: "bundle", value: tool("Run Bundler inside the builder service.", "bundle") },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const jekyllSnapshotYaml = recipeSnapshotYaml(jekyllSnapshot);
