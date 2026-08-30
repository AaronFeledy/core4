import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { BUILTIN_RECIPE_RENDERERS } from "../../src/recipes/builtin/registry.ts";

const SHIPPED_RECIPE_IDS = [
  "backdrop",
  "drupal",
  "drupal-cms",
  "joomla",
  "lamp",
  "laravel",
  "lemp",
  "mean",
  "rails",
  "symfony",
  "toolbox",
  "wordpress",
] as const;

const NO_PRIMARY_ROUTE_RECIPE_IDS = new Set(["toolbox", "empty"]);

const PRIMARY_HOSTNAME = 'hostname: "{{ app.name }}.{{ proxy.defaultDomain }}"';

const recipesRoot = resolve(import.meta.dirname, "../../../recipes");

const countRouteBlocks = (landofile: string): number => landofile.match(/\broutes:/g)?.length ?? 0;

const renderedLandofile = (recipeId: string): string => {
  const renderer = BUILTIN_RECIPE_RENDERERS.get(recipeId);
  expect(renderer, `[${recipeId}] missing registered renderer`).toBeDefined();
  if (renderer === undefined) return "";
  const rendered = renderer.render({ appName: "route-app", answers: {} });
  return [...rendered.values()].join("\n");
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
    for (const [recipeId] of BUILTIN_RECIPE_RENDERERS) {
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
