import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { nodeTsProducer } from "./snapshot.ts";

export const nodeTsDecomposer = makeZeroOptionDecomposer({
  producer: nodeTsProducer,
  displayName: "Node-ts",
  fragment: () => ({
    services: {
      web: {
        image: "node:{{ default(env.LANDO_NODE_VERSION, '24') }}",
        environment: { NODE_ENV: "{{ default(env.NODE_ENV, 'development') }}" },
        routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
      },
    },
  }),
});
