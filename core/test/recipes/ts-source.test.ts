import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveRecipeSource } from "../../src/recipes/resolved-source";
import { resolveRecipeRef } from "../../src/recipes/source";

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "recipe-ts-source-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const source = {
  id: "recipe",
  title: "Recipe",
  description: "TypeScript source",
  version: "1.0.0",
  config: {},
};

test("loads the host SDK author helper when a local directory has no dependency install", async () => {
  await withRoot(async (root) => {
    await Bun.write(
      join(root, "recipe/recipe.ts"),
      `import { defineRecipe } from "@lando/sdk/schema"; export default defineRecipe(${JSON.stringify(source)});`,
    );
    const acquired = await Effect.runPromise(resolveRecipeRef("./recipe", { cwd: root }));
    expect(acquired.authoredSource).toEqual(source);
    expect(acquired.evaluation).toBe("typescript");
  });
});

test("evaluates a local factory once per acquisition even when its carrier is copied and resolved twice", async () => {
  await withRoot(async (root) => {
    const counter = join(root, "recipe/count");
    await Bun.write(
      join(root, "recipe/recipe.ts"),
      `export default async () => {
      const file = Bun.file(${JSON.stringify(counter)});
      const count = await file.exists() ? Number(await file.text()) : 0;
      await Bun.write(${JSON.stringify(counter)}, String(count + 1));
      return ${JSON.stringify(source)};
    };`,
    );
    const acquired = await Effect.runPromise(resolveRecipeRef("./recipe", { cwd: root }));
    const first = await Effect.runPromise(resolveRecipeSource({ ...acquired }));
    const second = await Effect.runPromise(resolveRecipeSource(structuredClone(acquired)));
    expect(await Bun.file(counter).text()).toBe("1");
    expect(first.historyEligible).toBe(false);
    expect(second.source).toEqual(first.source);
    await Effect.runPromise(resolveRecipeRef("./recipe", { cwd: root }));
    expect(await Bun.file(counter).text()).toBe("2");
  });
});

test("marks a YAML child ineligible for history when its ancestor evaluated TypeScript", async () => {
  await withRoot(async (root) => {
    await Bun.write(join(root, "recipe/recipe.ts"), `export default ${JSON.stringify(source)};`);
    await Bun.write(
      join(root, "child/recipe.yml"),
      "id: child\ntitle: Child\ndescription: Child\nversion: 1.0.0\nconfig:\nextends: ../recipe\n",
    );
    const resolution = await Effect.runPromise(
      resolveRecipeRef("./child", { cwd: root }).pipe(Effect.flatMap(resolveRecipeSource)),
    );
    expect(resolution.historyEligible).toBe(false);
    expect(resolution.sources.map(({ evaluation }) => evaluation)).toEqual(["typescript", "declarative"]);
  });
});

for (const fixture of [
  {
    name: "missing version",
    code: 'export default { id: "recipe", title: "Recipe", description: "Missing", config: {} };',
    tag: "RecipeManifestValidationError",
  },
  {
    name: "mismatched id",
    code: `export default ${JSON.stringify({ ...source, id: "wrong" })};`,
    tag: "RecipeManifestValidationError",
  },
  {
    name: "authored snapshot",
    code: `export default ${JSON.stringify({ ...source, snapshot: {} })};`,
    tag: "RecipeManifestValidationError",
  },
  {
    name: "authored prompts",
    code: `export default ${JSON.stringify({ ...source, prompts: [] })};`,
    tag: "RecipeManifestValidationError",
  },
  { name: "missing default export", code: "export const recipe = {};", tag: "RecipeManifestParseError" },
  { name: "invalid syntax", code: "export default { <<<", tag: "RecipeManifestParseError" },
  {
    name: "require call",
    code: `const parser = require("parse"); export default ${JSON.stringify(source)};`,
    tag: "RecipeManifestParseError",
  },
  {
    name: "host subprocess import",
    code: `import { execSync } from "node:child_process"; export default ${JSON.stringify(source)};`,
    tag: "RecipeManifestParseError",
  },
]) {
  test(`rejects ${fixture.name} at the local TS boundary`, async () => {
    await withRoot(async (root) => {
      await Bun.write(join(root, "recipe/recipe.ts"), fixture.code);
      await expect(Effect.runPromise(resolveRecipeRef("./recipe", { cwd: root }))).rejects.toMatchObject({
        _tag: fixture.tag,
      });
    });
  });
}

test("rejects ambiguous local author files before evaluating TypeScript", async () => {
  await withRoot(async (root) => {
    await Bun.write(join(root, "recipe/recipe.ts"), `export default ${JSON.stringify(source)};`);
    await Bun.write(join(root, "recipe/recipe.yml"), "id: recipe\n");
    await expect(Effect.runPromise(resolveRecipeRef("./recipe", { cwd: root }))).rejects.toMatchObject({
      _tag: "RecipeManifestValidationError",
    });
  });
});

test("rejects a directory with no author file", async () => {
  await withRoot(async (root) => {
    await Bun.write(join(root, "recipe/.keep"), "");
    await expect(Effect.runPromise(resolveRecipeRef("./recipe", { cwd: root }))).rejects.toMatchObject({
      _tag: "RecipeManifestNotFoundError",
    });
  });
});
