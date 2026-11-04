import { RecipeSource } from "@lando/sdk/schema";
import { Schema } from "effect";

export const externalRecipeSource = (overrides: Partial<RecipeSource> = {}): RecipeSource =>
  Schema.decodeUnknownSync(RecipeSource)({
    id: "external",
    title: "External",
    description: "External fixture",
    version: "1.0.0",
    config: { runtime: 4, services: { app: { type: "lando", image: "alpine:3.21" } } },
    ...overrides,
  });
export const externalRecipeYaml = (source: RecipeSource): string =>
  `${Bun.YAML.stringify(source, null, 2)}\n`;
