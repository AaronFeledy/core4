import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const FASTAPI_RECIPE_VERSION = "0.1.0";
export const FASTAPI_CONTENT_DIGEST =
  "sha256:2e7e0d8da6937c1badc267093a9511b9beaa7f474400ca422009991752f567a7";

export const fastapiProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-fastapi",
  recipeId: "fastapi",
  manifestVersion: FASTAPI_RECIPE_VERSION,
  contentDigest: FASTAPI_CONTENT_DIGEST,
};

export const fastapiDefaults = {} as const;

const serviceOfType = (type: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [{ key: "type", value: { kind: "Literal", value: type } }],
});

const tool = (description: string, command: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "web" } },
    { key: "description", value: { kind: "Literal", value: description } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: command }] } },
  ],
});

export const fastapiSnapshot: RecipeSnapshot = {
  identity: fastapiProducer,
  optionTypes: {},
  defaults: fastapiDefaults,
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
                    { key: "type", value: { kind: "Literal", value: "python:3.12" } },
                    { key: "framework", value: { kind: "Literal", value: "fastapi" } },
                    { key: "port", value: { kind: "Literal", value: 8000 } },
                    {
                      key: "dependsOn",
                      value: {
                        kind: "ArrayLiteral",
                        elements: [
                          { kind: "Literal", value: "database" },
                          { kind: "Literal", value: "cache" },
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
              { key: "database", value: serviceOfType("postgres") },
              { key: "cache", value: serviceOfType("redis") },
            ],
          },
        },
        {
          key: "tooling",
          value: {
            kind: "ObjectLiteral",
            entries: [
              { key: "uvicorn", value: tool("Run uvicorn inside the web service.", "uvicorn") },
              { key: "pip", value: tool("Run pip inside the web service.", "pip") },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const fastapiSnapshotYaml = recipeSnapshotYaml(fastapiSnapshot);
