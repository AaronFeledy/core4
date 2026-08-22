import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const SHIPPED_RECIPE_IDS = [
  "backdrop",
  "drupal",
  "drupal-cms",
  "joomla",
  "lamp",
  "laravel",
  "lemp",
  "mean",
  "symfony",
  "toolbox",
  "wordpress",
] as const;

const recipesRoot = resolve(import.meta.dirname, "../../../recipes");

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
