import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { TOOLBOX_IMAGE } from "./image.ts";
import { toolboxProducer } from "./snapshot.ts";

export const toolboxDecomposer = makeZeroOptionDecomposer({
  producer: toolboxProducer,
  displayName: "Toolbox",
  fragment: () => ({
    services: {
      // The recipe supplies the image, so it states home intent rather than
      // letting planning guess where this image keeps a home.
      toolbox: {
        type: "lando",
        primary: true,
        image: TOOLBOX_IMAGE,
        command: "sleep infinity",
        home: false,
      },
    },
  }),
});
