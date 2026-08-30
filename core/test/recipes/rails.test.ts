import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Effect } from "effect";

import { RAILS_RECIPE_ID, railsRecipeYaml } from "../../src/recipes/builtin/rails/manifest.ts";
import { railsRenderer } from "../../src/recipes/builtin/rails/render.ts";
import { parseRecipe } from "../../src/recipes/manifest/service.ts";

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
    const files = railsRenderer.render({ appName: "rails-canon", answers: { name: "rails-canon" } });
    const landofile = files.get(".lando.yml");
    expect(landofile).toBeDefined();
    expect(landofile).toContain("type: ruby:3.3");
    expect(landofile).toContain("type: postgres");
    expect(landofile).toContain("type: redis");
    expect(landofile).toContain("  rails:\n");
    expect(landofile).toContain("  bundle:\n");
  });

  test("renders a web build.artifact that gem-installs rails and a Gemfile", () => {
    const files = railsRenderer.render({ appName: "rails-canon", answers: { name: "rails-canon" } });
    const landofile = files.get(".lando.yml");
    expect(landofile).toBeDefined();
    expect(landofile).toContain(
      '    build:\n      artifact:\n        - "apt-get update && apt-get install -y --no-install-recommends build-essential"\n        - "gem install rails --no-document"',
    );
    expect(files.get("Gemfile")).toBe('source "https://rubygems.org"\n');
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
