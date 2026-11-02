import type { RecipeSource } from "@lando/sdk/schema";

export const source = {
  id: "empty",
  title: "Empty Landofile",
  description: "Blank Landofile starter with no service opinion — pick services manually.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["starter"],
  config: { runtime: 4 },
  postInit: [{ type: "message", text: "Edit the generated .lando.yml to declare services for your stack." }],
} as const satisfies RecipeSource;
