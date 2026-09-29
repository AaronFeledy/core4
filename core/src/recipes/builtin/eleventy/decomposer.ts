import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { eleventyProducer } from "./snapshot.ts";

export const eleventyDecomposer = makeZeroOptionDecomposer({
  producer: eleventyProducer,
  displayName: "Eleventy",
  fragment: () => ({
    services: {
      builder: {
        type: "node:lts",
        primary: true,
        command: "npx @11ty/eleventy --serve --port 8080",
        port: 8080,
      },
      web: {
        primary: false,
        type: "static:nginx",
        appMount: { target: "/app" },
        routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
      },
    },
    tooling: {
      eleventy: {
        service: "builder",
        description: "Run the Eleventy CLI inside the builder service.",
        cmds: ["npx @11ty/eleventy"],
      },
      npm: { service: "builder", description: "Run npm inside the builder service.", cmds: ["npm"] },
    },
  }),
});
