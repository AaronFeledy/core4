import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { emptyProducer } from "./snapshot.ts";

export const emptyDecomposer = makeZeroOptionDecomposer({
  producer: emptyProducer,
  displayName: "Empty Landofile",
  fragment: () => ({}),
});
