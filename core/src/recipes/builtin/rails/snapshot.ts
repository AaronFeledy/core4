import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeAssetDigest } from "../snapshot-asset.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { RAILS_GEMFILE } from "./scaffold.ts";

export const RAILS_RECIPE_VERSION = "0.1.0";
export const RAILS_CONTENT_DIGEST = "sha256:1faa3a1a496dabcb300229d0db14e0e2d570506e785391f9332947d2b1febd65";

export const railsProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-rails",
  recipeId: "rails",
  manifestVersion: RAILS_RECIPE_VERSION,
  contentDigest: RAILS_CONTENT_DIGEST,
};

export const railsDefaults = {} as const;

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

const web = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "type", value: { kind: "Literal", value: "ruby:3.3" } },
    { key: "framework", value: { kind: "Literal", value: "rails" } },
    { key: "port", value: { kind: "Literal", value: 3000 } },
    {
      key: "build",
      value: {
        kind: "ObjectLiteral",
        entries: [
          {
            key: "artifact",
            value: {
              kind: "ArrayLiteral",
              elements: [
                {
                  kind: "Literal",
                  value: "apt-get update && apt-get install -y --no-install-recommends build-essential",
                },
                { kind: "Literal", value: "gem install rails --no-document" },
              ],
            },
          },
        ],
      },
    },
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
                value: { kind: "Literal", value: "{{ app.name }}.{{ proxy.defaultDomain }}" },
              },
              { key: "scheme", value: { kind: "Literal", value: "both" } },
            ],
          },
        ],
      },
    },
  ],
});

export const railsSnapshot: RecipeSnapshot = {
  identity: railsProducer,
  optionTypes: {},
  defaults: railsDefaults,
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
              { key: "web", value: web() },
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
              { key: "rails", value: tool("Run the Rails CLI inside the web service.", "rails") },
              { key: "bundle", value: tool("Run Bundler inside the web service.", "bundle") },
            ],
          },
        },
      ],
    },
  },
  assets: [{ dest: "Gemfile", digest: recipeAssetDigest(RAILS_GEMFILE), template: false }],
};

export const railsSnapshotYaml = recipeSnapshotYaml(railsSnapshot);
