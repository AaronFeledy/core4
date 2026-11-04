import { describe, expect, test } from "bun:test";

import { buildConfig } from "../../../core/build.config.ts";
import { BUNDLED_RECIPE_SOURCES } from "../../src/recipes/builtin/source-catalog.ts";
import { BUNDLED_RECIPES } from "../../src/recipes/bundled.ts";

describe("BUNDLED_RECIPES — generated bundled-recipes table", () => {
  test("contains exactly the recipes declared in core/build.config.ts", () => {
    const expectedIds = buildConfig.bundledRecipes.map((entry) => entry.id);
    const actualIds = BUNDLED_RECIPES.map((entry) => entry.id);
    expect(actualIds).toEqual(expectedIds);
  });

  test("node-postgres entry embeds author source and compiled output", () => {
    const entry = BUNDLED_RECIPES.find((recipe) => recipe.id === "node-postgres");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.source).toBe("node-postgres/recipe.yml");
    expect<unknown>(entry.authoredSource).toEqual(BUNDLED_RECIPE_SOURCES.get("node-postgres"));
    expect(entry.manifest.snapshot.identity.recipeId).toBe("node-postgres");
  });

  test("manifest yaml is embedded inline (compiled binary does not read from disk)", () => {
    for (const entry of BUNDLED_RECIPES) {
      expect(typeof entry.manifestYaml).toBe("string");
      expect(entry.manifestYaml.length).toBeGreaterThan(0);
      expect(Bun.YAML.parse(entry.manifestYaml)).toEqual(entry.authoredSource);
    }
  });
});
