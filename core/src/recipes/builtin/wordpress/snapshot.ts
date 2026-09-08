import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const WORDPRESS_RECIPE_VERSION = "0.1.0";
export const WORDPRESS_CONTENT_DIGEST =
  "sha256:150513ad53c5872e77c67ea226b472d7c985e3379998c550aa04bed92368be10";

export const wordpressProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-wordpress",
  recipeId: "wordpress",
  manifestVersion: WORDPRESS_RECIPE_VERSION,
  contentDigest: WORDPRESS_CONTENT_DIGEST,
};

export const wordpressSnapshot: RecipeSnapshot = {
  identity: wordpressProducer,
  optionTypes: {
    php: { kind: "enum", values: ["8.2", "8.3"] },
    redis: { kind: "boolean" },
  },
  defaults: { php: "8.3", redis: false },
  template: {
    expression: {
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
                        { key: "framework", value: { kind: "Literal", value: "wordpress" } },
                        { key: "port", value: { kind: "Literal", value: 80 } },
                        {
                          key: "dependsOn",
                          value: {
                            kind: "Conditional",
                            test: {
                              kind: "Path",
                              head: "options",
                              segments: [{ type: "prop", name: "redis" }],
                            },
                            consequent: {
                              kind: "ArrayLiteral",
                              elements: [
                                { kind: "Literal", value: "database" },
                                { kind: "Literal", value: "cache" },
                              ],
                            },
                            alternate: {
                              kind: "ArrayLiteral",
                              elements: [{ kind: "Literal", value: "database" }],
                            },
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
                  {
                    key: "database",
                    value: {
                      kind: "ObjectLiteral",
                      entries: [{ key: "type", value: { kind: "Literal", value: "mariadb" } }],
                    },
                  },
                ],
              },
              {
                kind: "Conditional",
                test: { kind: "Path", head: "options", segments: [{ type: "prop", name: "redis" }] },
                consequent: {
                  kind: "ObjectLiteral",
                  entries: [
                    {
                      key: "cache",
                      value: {
                        kind: "ObjectLiteral",
                        entries: [{ key: "type", value: { kind: "Literal", value: "redis" } }],
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
              {
                key: "wp",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    { key: "service", value: { kind: "Literal", value: "appserver" } },
                    {
                      key: "description",
                      value: { kind: "Literal", value: "Run WP-CLI inside the appserver service." },
                    },
                    {
                      key: "cmds",
                      value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "wp" }] },
                    },
                  ],
                },
              },
              {
                key: "composer",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    { key: "service", value: { kind: "Literal", value: "appserver" } },
                    {
                      key: "description",
                      value: { kind: "Literal", value: "Run Composer inside the appserver service." },
                    },
                    {
                      key: "cmds",
                      value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "composer" }] },
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
  assets: [],
};

export const wordpressSnapshotYaml = recipeSnapshotYaml(wordpressSnapshot);
