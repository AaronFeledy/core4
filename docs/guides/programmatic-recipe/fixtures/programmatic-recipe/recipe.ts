import { type Recipe, defineRecipe } from "@lando/sdk/schema";

const recipe: Recipe = {
  id: "programmatic-recipe",
  title: "Programmatic Recipe",
  description: "A recipe authored as TypeScript instead of recipe.yml.",
  version: "1.0.0",
  runs: ["composer", "git"],
  fetchAllowlist: ["https://api.example.com/**"],
  prompts: [{ name: "name", type: "text", message: "App name?" }],
  files: [{ src: "lando.yml.hbs", dest: ".lando.yml", template: true }],
  postInit: [{ type: "message", text: "Done!" }],
};

export default defineRecipe(recipe);
