import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { lit, obj } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { TOOLBOX_IMAGE } from "./image.ts";

export const TOOLBOX_RECIPE_VERSION = "0.1.0";
export const TOOLBOX_CONTENT_DIGEST =
  "sha256:6540da2fb72dcb90282aafb0308b43bdb601758a1a722b6549c138bc2dbfed92";
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
              ["home", lit(false)],
            ]),
          ],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const toolboxSnapshotYaml = recipeSnapshotYaml(toolboxSnapshot);
