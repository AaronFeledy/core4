import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { hugoProducer } from "./snapshot.ts";

export const hugoDecomposer = makeZeroOptionDecomposer({
  producer: hugoProducer,
  displayName: "Hugo",
  fragment: () => ({
    services: {
      builder: {
        type: "node:lts",
        primary: true,
        command: "npx hugo server --bind 0.0.0.0 --port 1313",
        port: 1313,
      },
      web: {
        primary: false,
        type: "static:nginx",
        appMount: { target: "/app" },
        routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
      },
    },
    tooling: {
      hugo: {
        service: "builder",
        description: "Run the Hugo CLI inside the builder service.",
        cmds: ["npx hugo"],
      },
      npm: { service: "builder", description: "Run npm inside the builder service.", cmds: ["npm"] },
    },
  }),
});
