import { type Recipe, defineRecipe } from "@lando/sdk/schema";

const recipe: Recipe = {
  id: "programmatic-recipe",
  title: "Programmatic Recipe",
  description: "A recipe authored as TypeScript instead of recipe.yml.",
  version: "1.0.0",
  runs: ["composer", "npm"],
  fetchAllowlist: ["https://api.example.com/**"],
  options: {
    phpVersion: {
      type: { kind: "enum", values: ["8.2", "8.3"] },
      prompt: { message: "PHP version?" },
      default: "8.3",
    },
  },
  config: { services: { appserver: { type: "php:{{ recipe.phpVersion }}" } } },
  postInit: [
    { type: "bun", verb: "install" },
    { type: "message", text: "Done!" },
  ],
};

export default defineRecipe(recipe);
