import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const NODE_TS_RECIPE_VERSION = "0.1.0";
export const NODE_TS_CONTENT_DIGEST =
  "sha256:867db3894c25320f4a9c58fcc8fed102cb87d3242b6138704ad2593d01621804";

export const nodeTsProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-node-ts",
  recipeId: "node-ts",
  manifestVersion: NODE_TS_RECIPE_VERSION,
  contentDigest: NODE_TS_CONTENT_DIGEST,
};

export const nodeTsDefaults = {} as const;

export const nodeTsSnapshot: RecipeSnapshot = {
  identity: nodeTsProducer,
  optionTypes: {},
  defaults: nodeTsDefaults,
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
                key: "web",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    {
                      key: "image",
                      value: { kind: "Literal", value: "node:{{ default(env.LANDO_NODE_VERSION, 'lts') }}" },
                    },
                    { key: "home", value: { kind: "Literal", value: false } },
                    {
                      key: "environment",
                      value: {
                        kind: "ObjectLiteral",
                        entries: [
                          {
                            key: "NODE_ENV",
                            value: { kind: "Literal", value: "{{ default(env.NODE_ENV, 'development') }}" },
                          },
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
      ],
    },
  },
  assets: [],
};

export const nodeTsSnapshotYaml = recipeSnapshotYaml(nodeTsSnapshot);
