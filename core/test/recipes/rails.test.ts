import { describe, expect, test } from "bun:test";
import { RecipeManifest } from "@lando/sdk/schema";
import { Schema } from "effect";
import { source } from "../../src/recipes/builtin/rails/source.ts";
import { bundledRecipeContentSource } from "../../src/recipes/builtin/scaffold-assets.ts";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";
import { decomposeBuiltinRecipe } from "../_support/recipe-output.ts";

const recipe = bundledRecipe("rails");
describe("rails canonical recipe", () => {
  test("generated artifact matches its sole author source", async () => {
    expect(recipe.authoredSource).toEqual(source);
    expect(await recompiledBundledDigest(recipe.manifest)).toBe(recipe.producer.contentDigest);
    expect(Schema.decodeUnknownSync(RecipeManifest)(recipe.manifest).id).toBe("rails");
  });
  test("has no synthetic app-name option or Landofile asset", () => {
    expect(recipe.manifest.prompts).toEqual([]);
    expect(recipe.manifest.files?.map(({ dest }) => dest)).toEqual(["Gemfile"]);
  });
  test("renders ruby, postgres, redis and rails/bundle/rake tooling", () => {
    expect(decomposeBuiltinRecipe("rails").fragment).toMatchObject({
      services: { web: { type: "ruby:3.3" }, database: { type: "postgres" }, cache: { type: "redis" } },
      tooling: {
        rails: { service: "web" },
        bundle: { service: "web" },
        rake: { service: "web", description: "Run Rake inside the web service.", cmds: ["rake"] },
      },
    });
  });
  test("renders gem installation and retains the exact Gemfile bytes", async () => {
    expect(decomposeBuiltinRecipe("rails").fragment).toMatchObject({
      services: {
        web: {
          build: {
            artifact: [
              "apt-get update && apt-get install -y --no-install-recommends build-essential",
              "gem install rails --no-document",
            ],
          },
        },
      },
    });
    expect(await bundledRecipeContentSource("rails")({ src: "templates/Gemfile", dest: "Gemfile" })).toBe(
      'source "https://rubygems.org"\n',
    );
  });
});
