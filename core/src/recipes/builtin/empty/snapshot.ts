import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const EMPTY_RECIPE_VERSION = "0.1.0";
export const EMPTY_CONTENT_DIGEST = "sha256:12842e47ec4cec015683253dd324d1a50921620ac44a73bacf051494c320e27c";

export const emptyProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-empty",
  recipeId: "empty",
  manifestVersion: EMPTY_RECIPE_VERSION,
  contentDigest: EMPTY_CONTENT_DIGEST,
};

export const emptyDefaults = {} as const;

export const emptySnapshot: RecipeSnapshot = {
  identity: emptyProducer,
  optionTypes: {},
  defaults: emptyDefaults,
  template: {
    expression: {
      kind: "ObjectLiteral",
      entries: [{ key: "runtime", value: { kind: "Literal", value: 4 } }],
    },
  },
  assets: [],
};

export const emptySnapshotYaml = recipeSnapshotYaml(emptySnapshot);
