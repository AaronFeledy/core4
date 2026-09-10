import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { BUILTIN_RECIPE_DECOMPOSERS } from "../../src/recipes/builtin/decomposers.ts";
import { decomposeBuiltinRecipe } from "../_support/recipe-output.ts";

const SHIPPED_RECIPE_IDS = [
  "astro",
  "backdrop",
  "django",
  "drupal",
  "drupal-cms",
  "eleventy",
  "empty",
  "fastapi",
  "hugo",
  "jekyll",
  "joomla",
  "lamp",
  "laravel",
  "lemp",
  "mean",
  "nextjs",
  "node-api",
  "node-postgres",
  "node-ts",
  "rails",
  "sveltekit",
  "symfony",
  "toolbox",
  "wordpress",
] as const;

const NO_PRIMARY_ROUTE_RECIPE_IDS = new Set(["toolbox", "empty"]);

const PRIMARY_HOSTNAME = '"hostname":"{{ app.name }}.{{ proxy.defaultDomain }}"';

const recipesRoot = resolve(import.meta.dirname, "../../../recipes");

const countRouteBlocks = (landofile: string): number => landofile.match(/"routes":/g)?.length ?? 0;

const renderedLandofile = (recipeId: string): string => {
  return JSON.stringify(decomposeBuiltinRecipe(recipeId).fragment);
};

describe("shipped recipe directories", () => {
  test("recipes/ contains exactly the shipped recipe ids", async () => {
    const entries = await readdir(recipesRoot, { withFileTypes: true });
    const onDisk = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();

    expect(onDisk).toEqual([...SHIPPED_RECIPE_IDS]);
  });
});

describe("shipped recipe primary routes", () => {
  test("every web-facing recipe emits exactly one routes block; toolbox and empty emit zero", () => {
    for (const [recipeId] of BUILTIN_RECIPE_DECOMPOSERS) {
      const landofile = renderedLandofile(recipeId);
      const routeBlocks = countRouteBlocks(landofile);
      if (NO_PRIMARY_ROUTE_RECIPE_IDS.has(recipeId)) {
        expect(routeBlocks, `[${recipeId}] expected zero routes blocks`).toBe(0);
        expect(landofile, `[${recipeId}] must not emit a primary hostname`).not.toContain(PRIMARY_HOSTNAME);
        continue;
      }
      expect(routeBlocks, `[${recipeId}] expected exactly one routes block`).toBe(1);
      expect(landofile, `[${recipeId}] missing expression hostname`).toContain(PRIMARY_HOSTNAME);
    }
  });
});
