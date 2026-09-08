import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const LEMP_RECIPE_VERSION = "0.1.0";
export const LEMP_CONTENT_DIGEST = "sha256:80ca634229dab6ae0c8b098dfd3b226aad65a9335a3d257495e361a1c0516f39";

export const lempProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-lemp",
  recipeId: "lemp",
  manifestVersion: LEMP_RECIPE_VERSION,
  contentDigest: LEMP_CONTENT_DIGEST,
};

export const lempSnapshot: RecipeSnapshot = {
  identity: lempProducer,
  optionTypes: { php: { kind: "enum", values: ["8.2", "8.3"] } },
  defaults: { php: "8.3" },
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
                    { key: "type", value: { kind: "Literal", value: "nginx" } },
                    { key: "port", value: { kind: "Literal", value: 80 } },
                    {
                      key: "dependsOn",
                      value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "appserver" }] },
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
                key: "appserver",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    { key: "type", value: { kind: "Literal", value: "php:{{ recipe.php }}" } },
                    { key: "framework", value: { kind: "Literal", value: "none" } },
                    {
                      key: "dependsOn",
                      value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "database" }] },
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
        },
        {
          key: "tooling",
          value: {
            kind: "ObjectLiteral",
            entries: [
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
              {
                key: "php",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    { key: "service", value: { kind: "Literal", value: "appserver" } },
                    {
                      key: "description",
                      value: { kind: "Literal", value: "Run the PHP CLI inside the appserver service." },
                    },
                    {
                      key: "cmds",
                      value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "php" }] },
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

export const lempSnapshotYaml = recipeSnapshotYaml(lempSnapshot);
