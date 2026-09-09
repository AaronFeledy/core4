import { expect, test } from "bun:test";

import { lookupRecipeRenderer } from "../../src/recipes/builtin/registry.ts";
import { bundledRecipeContentSource } from "../../src/recipes/builtin/scaffold-assets.ts";
import { renderAuxiliaryScaffold } from "../../src/recipes/init-pipeline/files.ts";

const APP_NAME = "parity-app";
const LANDOFILE_DESTS = new Set([".lando.yml", ".lando.ts"]);

test.each(["mean", "node-postgres", "rails"])(
  "bundled content source reproduces the %s renderer bytes",
  async (recipeId) => {
    // Given
    const renderer = lookupRecipeRenderer(recipeId);
    if (renderer === undefined) throw new Error(`Missing renderer for ${recipeId}`);
    const rendered = renderer.render({ appName: APP_NAME, answers: {} });
    const source = bundledRecipeContentSource(recipeId);
    const auxiliary = [...rendered.keys()].filter((dest) => !LANDOFILE_DESTS.has(dest));

    // When / Then
    expect(auxiliary.length).toBeGreaterThan(0);
    for (const dest of auxiliary) {
      const raw = await source({ src: `templates/${dest}`, dest, template: true });
      if (raw === undefined) throw new Error(`Bundled source has no bytes for ${recipeId}/${dest}`);
      expect(renderAuxiliaryScaffold(raw, APP_NAME)).toBe(rendered.get(dest) ?? "");
    }
  },
);

test("bundled content source declines a recipe it does not carry", async () => {
  // Given
  const source = bundledRecipeContentSource("lamp");

  // When
  const content = await source({ src: "templates/anything", dest: "anything", template: false });

  // Then
  expect(content).toBeUndefined();
});
