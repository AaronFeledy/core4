import { expect, test } from "bun:test";

import { MEAN_PACKAGE_JSON_TEMPLATE, MEAN_SERVER_JS } from "../../src/recipes/builtin/mean/scaffold.ts";
import {
  NODE_POSTGRES_PACKAGE_JSON_TEMPLATE,
  NODE_POSTGRES_SERVER_JS,
} from "../../src/recipes/builtin/node-postgres/scaffold.ts";
import { RAILS_GEMFILE } from "../../src/recipes/builtin/rails/scaffold.ts";
import { bundledRecipeContentSource } from "../../src/recipes/builtin/scaffold-assets.ts";
import { renderAuxiliaryScaffold } from "../../src/recipes/init-pipeline/files.ts";

const APP_NAME = "parity-app";
const ASSETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  mean: { "package.json": MEAN_PACKAGE_JSON_TEMPLATE, "server.js": MEAN_SERVER_JS },
  "node-postgres": {
    "package.json": NODE_POSTGRES_PACKAGE_JSON_TEMPLATE,
    "server.js": NODE_POSTGRES_SERVER_JS,
  },
  rails: { Gemfile: RAILS_GEMFILE },
};

test.each(["mean", "node-postgres", "rails"])(
  "bundled content source reproduces the %s neutral scaffold bytes",
  async (recipeId) => {
    // Given
    const assets = ASSETS[recipeId];
    if (assets === undefined) throw new Error(`Missing scaffold fixtures for ${recipeId}`);
    const source = bundledRecipeContentSource(recipeId);
    const auxiliary = Object.entries(assets);

    // When / Then
    expect(auxiliary.length).toBeGreaterThan(0);
    for (const [dest, expected] of auxiliary) {
      const raw = await source({ src: `templates/${dest}`, dest, template: true });
      if (raw === undefined) throw new Error(`Bundled source has no bytes for ${recipeId}/${dest}`);
      expect(raw).toBe(expected);
      expect(renderAuxiliaryScaffold(raw, APP_NAME)).toBe(expected.replaceAll("{{ app.name }}", APP_NAME));
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
