import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { jekyllProducer } from "./snapshot.ts";

export const jekyllDecomposer = makeZeroOptionDecomposer({
  producer: jekyllProducer,
  displayName: "Jekyll",
  fragment: () => ({
    services: {
      builder: {
        type: "ruby:3.3",
        primary: true,
        framework: "none",
        command: "bundle exec jekyll serve --host 0.0.0.0 --port 4000",
        port: 4000,
      },
      web: {
        primary: false,
        type: "static:nginx",
        appMount: { target: "/app" },
        routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
      },
    },
    tooling: {
      jekyll: {
        service: "builder",
        description: "Run the Jekyll CLI inside the builder service.",
        cmds: ["bundle exec jekyll"],
      },
      bundle: {
        service: "builder",
        description: "Run Bundler inside the builder service.",
        cmds: ["bundle"],
      },
    },
  }),
});
