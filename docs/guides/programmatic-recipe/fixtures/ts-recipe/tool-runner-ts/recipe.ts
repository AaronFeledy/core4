import { defineRecipe } from "@lando/sdk/schema";

export default defineRecipe({
  id: "tool-runner-ts",
  title: "Tool Runner (TypeScript)",
  description: "One disposable BusyBox service, authored as recipe.ts.",
  version: "1.0.0",
  config: {
    runtime: 4,
    services: {
      tools: { type: "lando", image: "busybox:1.37", command: "sleep infinity" },
    },
  },
  files: [{ src: "README.tmpl", dest: "README.md", template: true }],
});
