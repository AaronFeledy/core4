import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { TOOLBOX_IMAGE } from "./image.ts";
import { toolboxProducer } from "./snapshot.ts";

export const toolboxDecomposer = makeZeroOptionDecomposer({
  producer: toolboxProducer,
  displayName: "Toolbox",
  fragment: () => ({
    services: {
      toolbox: {
        type: "lando",
        primary: true,
        image: TOOLBOX_IMAGE,
        command: "sleep infinity",
      },
    },
  }),
});
