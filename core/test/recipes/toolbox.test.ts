import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Effect } from "effect";

import { parse } from "yaml";

import { TOOLBOX_RECIPE_ID, toolboxRecipeYaml } from "../../src/recipes/builtin/toolbox/manifest.ts";
import { toolboxRenderer } from "../../src/recipes/builtin/toolbox/render.ts";
import { parseRecipe } from "../../src/recipes/manifest/service.ts";

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
    const files = toolboxRenderer.render({ appName: "toolbox-canon", answers: { name: "toolbox-canon" } });
    const landofile = files.get(".lando.yml");
    expect(landofile).toBeDefined();
    const parsed = parse(landofile ?? "") as {
      services?: Record<string, { type?: string; image?: string }>;
    };
    const services = Object.entries(parsed.services ?? {});
    expect(services).toHaveLength(1);
    const [, service] = services[0] as [string, { type?: string; image?: string }];
    expect(service.type).toBe("lando");
    // Version-pinned: an explicit tag that is not `latest`.
    expect(service.image).toMatch(/:[0-9][A-Za-z0-9_.-]*$/);
  });
});
