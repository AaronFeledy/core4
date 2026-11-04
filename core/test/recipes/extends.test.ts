import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileRecipeSource, renderRecipeSnapshot } from "@lando/sdk/recipes";
import { Effect, Result } from "effect";
import { resolveRecipeSource } from "../../src/recipes/resolved-source";
import { resolveRecipeRef } from "../../src/recipes/source";

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "recipe-extends-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const yaml = (id: string, extra = "") =>
  `id: ${id}\ntitle: ${id}\ndescription: Inheritance\nversion: 1.0.0\nconfig:\n${extra}`;
const resolve = (root: string, id: string) =>
  Effect.runPromise(resolveRecipeRef(`./${id}`, { cwd: root }).pipe(Effect.flatMap(resolveRecipeSource)));

test.each([false, true])(
  "composes actual parent config before child variants when enabled is %s",
  async (enabled) => {
    await withRoot(async (root) => {
      await Bun.write(
        join(root, "parent/recipe.yml"),
        `id: parent
title: Parent
description: Parent
version: 1.0.0
tags:
  - parent-only
options:
  enabled:
    type:
      kind: boolean
    default: true
config:
  services:
    web:
      type: nginx
      webroot: base
variants:
  - when: options.enabled
    config:
      services:
        web:
          webroot: parent-variant
`,
      );
      await Bun.write(
        join(root, "child/recipe.yml"),
        `id: child
title: Child
description: Child
version: 2.0.0
extends: ../parent
config:
  services:
    web:
      webroot: child-base
variants:
  - when: options.enabled
    config:
      x-child: true
`,
      );
      const resolution = await resolve(root, "child");
      const manifest = Result.getOrThrow(
        compileRecipeSource(resolution.source, {
          sourceKind: "local",
          packageName: "child",
          assets: [],
          configLayers: resolution.configLayers,
        }),
      );
      const output = Result.getOrThrow(renderRecipeSnapshot(manifest.snapshot, { enabled }));
      expect(output).toEqual({
        services: { web: { type: "nginx", webroot: "child-base" } },
        ...(enabled ? { "x-child": true } : {}),
      });
      expect(manifest.tags).toBeUndefined();
      expect(manifest.snapshot.identity.recipeId).toBe("child");
      expect(manifest.version).toBe("2.0.0");
    });
  },
);

test("allows three inheritance hops and retains each ordered source", async () => {
  await withRoot(async (root) => {
    for (const [id, parent] of [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", ""],
    ]) {
      await Bun.write(
        join(root, `${id}/recipe.yml`),
        yaml(id ?? "", parent ? `extends: ../${parent}\n` : ""),
      );
    }
    expect((await resolve(root, "a")).sources.map(({ value }) => value.id)).toEqual(["d", "c", "b", "a"]);
  });
});

test("rejects four inheritance hops with a complete chain", async () => {
  await withRoot(async (root) => {
    for (const [id, parent] of [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "e"],
      ["e", ""],
    ]) {
      await Bun.write(
        join(root, `${id}/recipe.yml`),
        yaml(id ?? "", parent ? `extends: ../${parent}\n` : ""),
      );
    }
    await expect(resolve(root, "a")).rejects.toMatchObject({
      _tag: "RecipeExtendsError",
      kind: "depth",
      chain: ["a", "b", "c", "d", "e"].map((id) => join(root, id)),
    });
  });
});

test("rejects a cycle before revisiting a source", async () => {
  await withRoot(async (root) => {
    await Bun.write(join(root, "a/recipe.yml"), yaml("a", "extends: ../b\n"));
    await Bun.write(join(root, "b/recipe.yml"), yaml("b", "extends: ../a\n"));
    await expect(resolve(root, "a")).rejects.toMatchObject({ _tag: "RecipeExtendsError", kind: "cycle" });
  });
});

test("rejects a missing bundled parent", async () => {
  await withRoot(async (root) => {
    await Bun.write(join(root, "a/recipe.yml"), yaml("a", "extends: missing-recipe\n"));
    await expect(resolve(root, "a")).rejects.toMatchObject({
      _tag: "RecipeExtendsError",
      kind: "parent-not-found",
    });
  });
});

test("rejects unsupported authored fields on an ancestor rather than silently stripping them", async () => {
  await withRoot(async (root) => {
    await Bun.write(join(root, "a/recipe.yml"), yaml("a", "extends: ../b\n"));
    await Bun.write(join(root, "b/recipe.yml"), yaml("b", "snapshot:\n"));
    await expect(resolve(root, "a")).rejects.toMatchObject({ _tag: "RecipeManifestValidationError" });
  });
});
