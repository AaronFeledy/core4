import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { lit, obj } from "../snapshot-expression.ts";
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
export const toolboxSnapshot: RecipeSnapshot = {
  identity: toolboxProducer,
  optionTypes: {},
  defaults: toolboxDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        obj([
          [
            "toolbox",
            obj([
              ["type", lit("lando")],
              ["primary", lit(true)],
              ["image", lit(TOOLBOX_IMAGE)],
              ["command", lit("sleep infinity")],
            ]),
          ],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const toolboxSnapshotYaml = recipeSnapshotYaml(toolboxSnapshot);
