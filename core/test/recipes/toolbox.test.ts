import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Effect } from "effect";

import { TOOLBOX_IMAGE } from "../../src/recipes/builtin/toolbox/image.ts";
import { TOOLBOX_RECIPE_ID, toolboxRecipeYaml } from "../../src/recipes/builtin/toolbox/manifest.ts";
import { parseRecipe } from "../../src/recipes/manifest/service.ts";
import { decomposeBuiltinRecipe } from "../_support/recipe-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CANONICAL_RECIPE_PATH = resolve(REPO_ROOT, "recipes/toolbox/recipe.yml");

describe("toolbox canonical recipe", () => {
  test("canonical recipes/toolbox/recipe.yml stays in sync with the embedded manifest", async () => {
    const onDisk = await Bun.file(CANONICAL_RECIPE_PATH).text();
    expect(onDisk).toBe(toolboxRecipeYaml);
  });

  test("manifest parses against the RecipeManifest schema", async () => {
    const manifest = await Effect.runPromise(parseRecipe("toolbox/recipe.yml", toolboxRecipeYaml));
    expect(manifest.id).toBe(TOOLBOX_RECIPE_ID);
    expect(manifest.title.length).toBeGreaterThan(0);
  });

  test("every prompt has a non-interactive default", async () => {
    const manifest = await Effect.runPromise(parseRecipe("toolbox/recipe.yml", toolboxRecipeYaml));
    expect(manifest.prompts?.length ?? 0).toBeGreaterThan(0);
    for (const prompt of manifest.prompts ?? []) {
      expect(prompt.default, `prompt "${prompt.name}" must declare a default`).toBeDefined();
    }
  });

  test("renders exactly one `type: lando` service with a version-pinned image", () => {
    const { fragment } = decomposeBuiltinRecipe("toolbox");
    expect(fragment).toMatchObject({ services: { toolbox: { type: "lando", image: TOOLBOX_IMAGE } } });
    const services = Reflect.get(Object(fragment), "services");
    expect(Object.keys(services)).toEqual(["toolbox"]);
    // Version-pinned: an explicit tag that is not `latest`.
    expect(TOOLBOX_IMAGE).toMatch(/:[0-9][A-Za-z0-9_.-]*$/);
  });
});
