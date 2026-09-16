import { expect, test } from "bun:test";
import {
  computeRecipeContentDigest,
  recipeContentDigestProjection,
} from "../../src/recipes/content-digest.ts";
import type { RecipeManifest } from "../../src/schema/recipe.ts";

const digest = `sha256:${"a".repeat(64)}`;
const snapshot = {
  identity: {
    sourceKind: "bundled" as const,
    packageName: "recipes",
    recipeId: "php",
    manifestVersion: "1.0.0",
    contentDigest: digest,
  },
  optionTypes: { php: { kind: "string" as const } },
  defaults: { php: "8.2" },
  template: { expression: { kind: "Literal" as const, value: "ok" } },
  assets: [{ dest: "README.md", digest }],
};
const base = (): RecipeManifest => ({
  id: "php",
  version: "1.0.0",
  title: "PHP",
  description: "PHP",
  snapshot,
  files: [{ src: "README.md", dest: "README.md" }],
  postInit: [{ type: "gitInit" }],
  prompts: [{ name: "php", type: "text", message: "PHP version", default: "8.2" }],
});

test("identical projections hash identically", () => {
  expect(computeRecipeContentDigest(recipeContentDigestProjection(base()))).toBe(
    computeRecipeContentDigest(recipeContentDigestProjection(base())),
  );
});

test("template, defaults, assets, files, and postInit are digest-sensitive", () => {
  const original = computeRecipeContentDigest(recipeContentDigestProjection(base()));
  const mutate = (patch: Partial<RecipeManifest>) =>
    computeRecipeContentDigest(recipeContentDigestProjection({ ...base(), ...patch }));
  expect(
    mutate({
      snapshot: {
        ...snapshot,
        template: { expression: { kind: "Literal", value: "changed" } },
      },
    }),
  ).not.toBe(original);
  expect(mutate({ snapshot: { ...snapshot, defaults: { php: "8.4" } } })).not.toBe(original);
  expect(mutate({ snapshot: { ...snapshot, assets: [] } })).not.toBe(original);
  expect(mutate({ files: [] })).not.toBe(original);
  expect(mutate({ postInit: [] })).not.toBe(original);
});

test("migrations, snapshot identity, and prompt defaults are digest-insensitive", () => {
  const original = computeRecipeContentDigest(recipeContentDigestProjection(base()));
  const withHistory = computeRecipeContentDigest(
    recipeContentDigestProjection({
      ...base(),
      migrations: [
        {
          from: snapshot.identity,
          to: snapshot.identity,
          fromSnapshot: snapshot,
          toSnapshot: snapshot,
          hunks: [],
        },
      ],
      snapshot: {
        ...snapshot,
        identity: { ...snapshot.identity, contentDigest: `sha256:${"b".repeat(64)}` },
      },
      prompts: [{ name: "php", type: "text", message: "PHP version", default: "never-hash-this" }],
    }),
  );
  expect(withHistory).toBe(original);
  expect(JSON.stringify(recipeContentDigestProjection(base()))).not.toContain("never-hash-this");
  expect(JSON.stringify(recipeContentDigestProjection(base()))).not.toContain("migrations");
});
