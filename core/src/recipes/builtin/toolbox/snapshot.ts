import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { TOOLBOX_IMAGE } from "./image.ts";

export const TOOLBOX_RECIPE_VERSION = "0.1.0";
export const TOOLBOX_CONTENT_DIGEST =
  "sha256:4b5e0f9d25dcd214e0bbe5ade44833400aee0e7afade5d633fa4a6a333afa4dd";

export const toolboxProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-toolbox",
  recipeId: "toolbox",
  manifestVersion: TOOLBOX_RECIPE_VERSION,
  contentDigest: TOOLBOX_CONTENT_DIGEST,
};

export const toolboxDefaults = {} as const;

const literal = (value: string | number | boolean): ExpressionNode => ({ kind: "Literal", value });

const toolboxService = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "type", value: literal("lando") },
    { key: "primary", value: literal(true) },
    { key: "image", value: literal(TOOLBOX_IMAGE) },
    { key: "command", value: literal("sleep infinity") },
  ],
});

export const toolboxSnapshot: RecipeSnapshot = {
  identity: toolboxProducer,
  optionTypes: {},
  defaults: toolboxDefaults,
  template: {
    expression: {
      kind: "ObjectLiteral",
      entries: [
        { key: "runtime", value: literal(4) },
        {
          key: "services",
          value: {
            kind: "ObjectLiteral",
            entries: [{ key: "toolbox", value: toolboxService() }],
          },
        },
      ],
    },
  },
  assets: [],
};

export const toolboxSnapshotYaml = recipeSnapshotYaml(toolboxSnapshot);
