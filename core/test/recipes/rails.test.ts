import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Effect } from "effect";

import { RAILS_RECIPE_ID, railsRecipeYaml } from "../../src/recipes/builtin/rails/manifest.ts";
import { bundledRecipeContentSource } from "../../src/recipes/builtin/scaffold-assets.ts";
import { parseRecipe } from "../../src/recipes/manifest/service.ts";
import { decomposeBuiltinRecipe } from "../_support/recipe-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CANONICAL_RECIPE_PATH = resolve(REPO_ROOT, "recipes/rails/recipe.yml");
const PROGRAMMATIC_RECIPE_PATH = resolve(REPO_ROOT, "recipes/rails/recipe.ts");

describe("rails canonical recipe", () => {
  test("canonical recipes/rails/recipe.yml stays in sync with the embedded manifest", async () => {
    const onDisk = await Bun.file(CANONICAL_RECIPE_PATH).text();
    expect(onDisk).toBe(railsRecipeYaml);
  });

  test("manifest parses against the RecipeManifest schema", async () => {
    const manifest = await Effect.runPromise(parseRecipe("rails/recipe.yml", railsRecipeYaml));
    expect(manifest.id).toBe(RAILS_RECIPE_ID);
    expect(manifest.title.length).toBeGreaterThan(0);
  });

  test("every prompt has a non-interactive default", async () => {
    const manifest = await Effect.runPromise(parseRecipe("rails/recipe.yml", railsRecipeYaml));
    expect(manifest.prompts?.length ?? 0).toBeGreaterThan(0);
    for (const prompt of manifest.prompts ?? []) {
      expect(prompt.default, `prompt "${prompt.name}" must declare a default`).toBeDefined();
    }
  });

  test("ships a single name prompt", async () => {
    const manifest = await Effect.runPromise(parseRecipe("rails/recipe.yml", railsRecipeYaml));
    expect(manifest.prompts).toHaveLength(1);
    expect(manifest.prompts?.[0]?.name).toBe("name");
  });

  test("renders ruby, postgres, redis, and rails/bundle tooling", () => {
    const { fragment } = decomposeBuiltinRecipe("rails");
    expect(fragment).toMatchObject({
      services: { web: { type: "ruby:3.3" }, database: { type: "postgres" }, cache: { type: "redis" } },
      tooling: { rails: { service: "web" }, bundle: { service: "web" } },
    });
  });

  test("renders a web build.artifact that gem-installs rails and a Gemfile", async () => {
    const { fragment } = decomposeBuiltinRecipe("rails");
    expect(fragment).toMatchObject({
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

  test("manifest files dest list includes Gemfile so init writes it", async () => {
    const manifest = await Effect.runPromise(parseRecipe("rails/recipe.yml", railsRecipeYaml));
    expect(manifest.files?.map((file) => file.dest)).toEqual([".lando.yml", "Gemfile"]);
  });

  test("does not ship a programmatic recipe.ts beside recipe.yml", async () => {
    const exists = await Bun.file(PROGRAMMATIC_RECIPE_PATH).exists();
    expect(exists).toBe(false);
  });
});
