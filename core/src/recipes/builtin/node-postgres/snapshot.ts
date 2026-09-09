import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { recipeAssetDigest } from "../snapshot-asset.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { NODE_POSTGRES_PACKAGE_JSON_TEMPLATE, NODE_POSTGRES_SERVER_JS } from "./scaffold.ts";

export const NODE_POSTGRES_RECIPE_VERSION = "0.1.0";
export const NODE_POSTGRES_CONTENT_DIGEST =
  "sha256:cbaec387ad0911dd659f35ad6970123cd4c4668f10b3b7ad1d5ae768c76975a0";

export const nodePostgresProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-node-postgres",
  recipeId: "node-postgres",
  manifestVersion: NODE_POSTGRES_RECIPE_VERSION,
  contentDigest: NODE_POSTGRES_CONTENT_DIGEST,
};

export const nodePostgresDefaults = {} as const;

export const nodePostgresSnapshot: RecipeSnapshot = {
  identity: nodePostgresProducer,
  optionTypes: {},
  defaults: nodePostgresDefaults,
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
                    { key: "type", value: { kind: "Literal", value: "node:lts" } },
                    {
                      key: "ports",
                      value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "3000:3000" }] },
                    },
                    {
                      key: "environment",
                      value: {
                        kind: "ObjectLiteral",
                        entries: [{ key: "NODE_ENV", value: { kind: "Literal", value: "development" } }],
                      },
                    },
                    {
                      key: "volumes",
                      value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "./:/app" }] },
                    },
                    { key: "command", value: { kind: "Literal", value: "node /app/server.js" } },
                    {
                      key: "dependsOn",
                      value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "database" }] },
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
                  entries: [{ key: "type", value: { kind: "Literal", value: "postgres" } }],
                },
              },
            ],
          },
        },
      ],
    },
  },
  assets: [
    { dest: "package.json", digest: recipeAssetDigest(NODE_POSTGRES_PACKAGE_JSON_TEMPLATE), template: true },
    { dest: "server.js", digest: recipeAssetDigest(NODE_POSTGRES_SERVER_JS), template: false },
  ],
};

export const nodePostgresSnapshotYaml = recipeSnapshotYaml(nodePostgresSnapshot);
