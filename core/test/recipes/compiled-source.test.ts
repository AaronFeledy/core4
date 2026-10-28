import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecipeSource } from "@lando/sdk/schema";
import { Effect } from "effect";
import { compileResolvedRecipe } from "../../src/recipes/compiled-source.ts";
import { composeRecipeSources } from "../../src/recipes/manifest/merge.ts";
import type { ResolvedAuthoredSource } from "../../src/recipes/resolved-source-types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const directory = async () => {
  const root = await mkdtemp(join(tmpdir(), "compiled-source-"));
  roots.push(root);
  return root;
};
const declaration = (root: string, value: RecipeSource): ResolvedAuthoredSource => ({
  value,
  origin: { kind: "directory", root },
  evaluation: "declarative",
  evidence: { contentDigest: `sha256:${"0".repeat(64)}` },
});
const source: RecipeSource = {
  id: "example",
  title: "Example",
  description: "Compiled fixture",
  version: "1.0.0",
  config: { services: { app: { type: "node:22" } } },
  files: [{ src: "asset.bin", dest: "asset.bin" }],
};

test("retains exact observed bytes when the source and returned buffers mutate", async () => {
  // Given
  const root = await directory();
  const raw = new Uint8Array([0, 255, 239, 187, 191]);
  await writeFile(join(root, "asset.bin"), raw);
  const resolution = composeRecipeSources([], declaration(root, source));
  // When
  const compiled = await Effect.runPromise(compileResolvedRecipe(resolution));
  await writeFile(join(root, "asset.bin"), "replacement");
  compiled.files[0]?.content.fill(42);
  // Then
  expect(compiled.files[0]?.content).toEqual(raw);
  expect(compiled.snapshot.assets[0]?.digest).toBe(compiled.files[0]?.digest);
  expect(Object.isFrozen(compiled.manifest.snapshot.template)).toBe(true);
});

test("includes parent asset evidence even when a child replaces that destination", async () => {
  // Given
  const parentRoot = await directory();
  const childRoot = await directory();
  await writeFile(join(parentRoot, "asset.bin"), "parent-before");
  await writeFile(join(childRoot, "asset.bin"), "child");
  const parent = declaration(parentRoot, source);
  const child = declaration(childRoot, { ...source, id: "child" });
  const resolution = composeRecipeSources([parent], child);
  const before = await Effect.runPromise(compileResolvedRecipe(resolution));
  // When
  await writeFile(join(parentRoot, "asset.bin"), "parent-after");
  const after = await Effect.runPromise(compileResolvedRecipe(resolution));
  // Then
  expect(after.files[0]?.digest).toBe(before.files[0]?.digest);
  expect(after.parents[0]?.contentDigest).not.toBe(before.parents[0]?.contentDigest);
  expect(after.producer.contentDigest).not.toBe(before.producer.contentDigest);
});

test("excludes private source roots and derives local trust despite a package label", async () => {
  // Given
  const first = await directory();
  const second = await directory();
  for (const root of [first, second]) await writeFile(join(root, "asset.bin"), "same");
  const claimed = { ...source, package: "@lando/core" };
  // When
  const compiled = await Promise.all(
    [first, second].map((root) =>
      Effect.runPromise(compileResolvedRecipe(composeRecipeSources([], declaration(root, claimed)))),
    ),
  );
  // Then
  expect(compiled[0]?.producer).toEqual(compiled[1]?.producer);
  expect(compiled[0]?.producer.sourceKind).toBe("local");
});

test("includes observed script digests in identity without publishing them as output assets", async () => {
  // Given
  const root = await directory();
  await writeFile(join(root, "init.bun.sh"), "first");
  const scripted: RecipeSource = {
    ...source,
    files: [],
    postInit: [{ type: "bun", verb: "script", script: "init.bun.sh" }],
  };
  const resolution = composeRecipeSources([], declaration(root, scripted));
  const before = await Effect.runPromise(compileResolvedRecipe(resolution));
  // When
  await writeFile(join(root, "init.bun.sh"), "second");
  const after = await Effect.runPromise(compileResolvedRecipe(resolution));
  // Then
  expect(after.producer.contentDigest).not.toBe(before.producer.contentDigest);
  expect(after.snapshot.assets).toEqual([]);
  expect(new TextDecoder().decode(before.postInit[0]?.content)).toBe("first");
});
