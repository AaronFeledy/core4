import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { nodeTsProducer } from "./snapshot.ts";

export const nodeTsDecomposer = makeZeroOptionDecomposer({
  producer: nodeTsProducer,
  displayName: "Node-ts",
  fragment: () => ({
    services: {
      web: {
        image: "node:{{ default(env.LANDO_NODE_VERSION, 'lts') }}",
        // The recipe supplies the image, so it states home intent rather
        // than letting planning guess where this image keeps a home.
        home: false,
        environment: { NODE_ENV: "{{ default(env.NODE_ENV, 'development') }}" },
        routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
      },
    },
  }),
});
