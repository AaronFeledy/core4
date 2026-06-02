import { type Recipe, defineRecipe } from "@lando/sdk/schema";

const recipe: Recipe = {
  id: "programmatic-recipe",
  title: "Programmatic Recipe",
  description: "A recipe authored as TypeScript instead of recipe.yml.",
  version: "1.0.0",
  runs: ["composer", "npm"],
  fetchAllowlist: ["https://api.example.com/**"],
  prompts: [
    { name: "name", type: "text", message: "App name?" },
    {
      name: "phpVersion",
      type: "select",
      message: "PHP version?",
      default: "8.3",
      choices: ["8.2", "8.3"],
    },
  ],
  files: [{ src: "lando.yml.hbs", dest: ".lando.yml", template: true }],
  postInit: [
    { type: "bun", verb: "install" },
    { type: "message", text: "Done!" },
  ],
};

export default defineRecipe(recipe);
