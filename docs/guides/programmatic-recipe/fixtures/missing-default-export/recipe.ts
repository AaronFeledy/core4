import { defineRecipe } from "@lando/sdk/schema";

// Named export only: Lando needs `export default`.
export const recipe = defineRecipe({
  id: "missing-default-export",
  title: "Missing Default Export",
  description: "Declares a recipe but never default-exports it.",
  version: "0.1.0",
  config: {
    runtime: 4,
    services: {
      tools: { type: "lando", image: "busybox:1.37", command: "sleep infinity" },
    },
  },
});
