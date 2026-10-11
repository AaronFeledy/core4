import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { HUGO_BUILD_ARTIFACT } from "./install.ts";
import { hugoProducer } from "./snapshot.ts";

export const hugoDecomposer = makeZeroOptionDecomposer({
  producer: hugoProducer,
  displayName: "Hugo",
  fragment: () => ({
    services: {
      builder: {
        type: "node:lts",
        primary: true,
        build: { artifact: [...HUGO_BUILD_ARTIFACT] },
        command: "hugo server --bind 0.0.0.0 --port 1313",
        port: 1313,
      },
      web: {
        primary: false,
        type: "static:nginx",
        appMount: { target: "/app" },
        webroot: "/app/public",
        routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
      },
    },
    tooling: {
      hugo: {
        service: "builder",
        description: "Run the Hugo CLI inside the builder service.",
        cmds: ["hugo"],
      },
      npm: { service: "builder", description: "Run npm inside the builder service.", cmds: ["npm"] },
    },
  }),
});
