import { describe, expect, test } from "bun:test";

import { buildConfig } from "../../../core/build.config.ts";
import {
  NODE_POSTGRES_RECIPE_ID,
  nodePostgresRecipeSource,
  nodePostgresRecipeYaml,
} from "../../src/recipes/builtin/node-postgres/manifest.ts";
import { BUNDLED_RECIPES } from "../../src/recipes/bundled.ts";

describe("BUNDLED_RECIPES — generated bundled-recipes table", () => {
  test("contains exactly the recipes declared in core/build.config.ts", () => {
    const expectedIds = buildConfig.bundledRecipes.map((entry) => entry.id);
    const actualIds = BUNDLED_RECIPES.map((entry) => entry.id);
    expect(actualIds).toEqual(expectedIds);
  });

  test("node-postgres entry embeds the manifest source string from manifest.ts", () => {
    const entry = BUNDLED_RECIPES.find((recipe) => recipe.id === NODE_POSTGRES_RECIPE_ID);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.source).toBe(nodePostgresRecipeSource);
    expect(entry.manifestYaml).toBe(nodePostgresRecipeYaml);
  });

  test("manifest yaml is embedded inline (compiled binary does not read from disk)", () => {
    for (const entry of BUNDLED_RECIPES) {
      expect(typeof entry.manifestYaml).toBe("string");
      expect(entry.manifestYaml.length).toBeGreaterThan(0);
      expect(entry.manifestYaml).toContain(`id: ${entry.id}`);
    }
  });
});
