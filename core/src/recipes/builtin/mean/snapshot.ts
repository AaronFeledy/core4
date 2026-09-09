import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { recipeAssetDigest } from "../snapshot-asset.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { MEAN_PACKAGE_JSON_TEMPLATE, MEAN_SERVER_JS } from "./scaffold.ts";

export const MEAN_RECIPE_VERSION = "0.1.0";
export const MEAN_CONTENT_DIGEST = "sha256:cac690f4c0552c0d605f52f4b0cf43fc630c6c3d1ea1280711374508223b0798";

export const meanProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-mean",
  recipeId: "mean",
  manifestVersion: MEAN_RECIPE_VERSION,
  contentDigest: MEAN_CONTENT_DIGEST,
};

export const meanDefaults = { node: "lts", redis: false } as const;

const redisEnabled = (): ExpressionNode => ({
  kind: "Path",
  head: "options",
  segments: [{ type: "prop", name: "redis" }],
});

const environment = (redis: boolean): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "NODE_ENV", value: { kind: "Literal", value: "development" } },
    { key: "PORT", value: { kind: "Literal", value: 3000 } },
    {
      key: "MONGO_URL",
      value: {
        kind: "Literal",
        value: "mongodb://lando:lando@database:27017/{{ app.name }}?authSource=admin",
      },
    },
    ...(redis
      ? [{ key: "REDIS_URL", value: { kind: "Literal" as const, value: "redis://cache:6379" } }]
      : []),
  ],
});

const services = (redis: boolean): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    {
      key: "api",
      value: {
        kind: "ObjectLiteral",
        entries: [
          { key: "type", value: { kind: "Literal", value: "node:{{ recipe.node }}" } },
          { key: "port", value: { kind: "Literal", value: 3000 } },
          {
            key: "environment",
            value: {
              kind: "Conditional",
              test: redisEnabled(),
              consequent: environment(true),
              alternate: environment(false),
            },
          },
          {
            key: "dependsOn",
            value: {
              kind: "Conditional",
              test: redisEnabled(),
              consequent: {
                kind: "ArrayLiteral",
                elements: [
                  { kind: "Literal", value: "database" },
                  { kind: "Literal", value: "cache" },
                ],
              },
              alternate: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "database" }] },
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
        ],
      },
    },
    {
      key: "database",
      value: {
        kind: "ObjectLiteral",
        entries: [{ key: "type", value: { kind: "Literal", value: "mongodb" } }],
      },
    },
    ...(redis
      ? [
          {
            key: "cache",
            value: {
              kind: "ObjectLiteral" as const,
              entries: [{ key: "type", value: { kind: "Literal" as const, value: "redis" } }],
            },
          },
        ]
      : []),
  ],
});

const tool = (description: string, command: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "api" } },
    { key: "description", value: { kind: "Literal", value: description } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: command }] } },
  ],
});

export const meanSnapshot: RecipeSnapshot = {
  identity: meanProducer,
  optionTypes: {
    node: { kind: "enum", values: ["lts", "22"] },
    redis: { kind: "boolean" },
  },
  defaults: meanDefaults,
  template: {
    expression: {
      kind: "ObjectLiteral",
      entries: [
        { key: "runtime", value: { kind: "Literal", value: 4 } },
        {
          key: "services",
          value: {
            kind: "Conditional",
            test: redisEnabled(),
            consequent: services(true),
            alternate: services(false),
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
  assets: [
    { dest: "package.json", digest: recipeAssetDigest(MEAN_PACKAGE_JSON_TEMPLATE), template: true },
    { dest: "server.js", digest: recipeAssetDigest(MEAN_SERVER_JS), template: true },
  ],
};

export const meanSnapshotYaml = recipeSnapshotYaml(meanSnapshot);
