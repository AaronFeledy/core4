import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeSourceError } from "@lando/sdk/errors";
import {
  normalizeRecipeSubpath,
  recipeFileExists,
  recipeUserDataRoot,
  resolveRecipeManifest,
} from "../../src/recipes/source-support.ts";

const fail = (input: ConstructorParameters<typeof RecipeSourceError>[0]): never => {
  throw new RecipeSourceError(input);
};

describe("recipe source support", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-source-support-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const wording of [
    { label: "Git", container: "cloned repository", noun: "repository" },
    { label: "Tarball", container: "extracted archive", noun: "archive" },
  ] as const) {
    test(`${wording.label} normalizes a relative subpath`, () => {
      // Given / When: a safe path containing redundant separators and dot segments.
      const result = normalizeRecipeSubpath("./a//b", wording, fail);
      // Then: normalization retains its location.
      expect(result).toBe(join("a", "b"));
    });

    test.each([undefined, "", " ", "."])(`${wording.label} treats %s as top-level`, (path) => {
      // Given / When: an existing top-level spelling.
      const result = normalizeRecipeSubpath(path, wording, fail);
      // Then: the caller selects the published root.
      expect(result).toBeUndefined();
    });

    test.each([
      { path: "/absolute", reason: "must be relative and stay inside" },
      { path: "..", reason: "escapes" },
      { path: "a/../../escape", reason: "escapes" },
      { path: "./", reason: "escapes" },
    ])(`${wording.label} rejects $path with source wording`, ({ path, reason }) => {
      // Given / When: an absolute, escaping, or normalized-empty path.
      const resolve = () => normalizeRecipeSubpath(path, wording, fail);
      // Then: the original source-specific diagnostic survives.
      expect(resolve).toThrow(
        expect.objectContaining({
          _tag: "RecipeSourceError",
          kind: "subpath-invalid",
          source: path,
          message: `${wording.label} recipe --path ${reason} the ${wording.container}: ${path}`,
          remediation: `Pass a relative path inside the ${wording.noun}, such as --path=packages/foo.`,
        }),
      );
    });
  }

  test("returns an explicit user data root without resolving config", async () => {
    // Given / When: a non-default override.
    const result = await recipeUserDataRoot(root);
    // Then: it is passed through unchanged.
    expect(result).toBe(root);
  });

  test.each(["directory", "file", "missing"])("tests existence of a %s", async (kind) => {
    // Given: directories count as existing, just like stat in the original sources.
    const path = join(root, kind);
    if (kind === "directory") await mkdir(path);
    if (kind === "file") await writeFile(path, "data");
    // When: the recipe cache checks existence.
    const result = await recipeFileExists(path);
    // Then: only the missing path returns false.
    expect(result).toBe(kind !== "missing");
  });

  for (const sourceKind of ["git", "tarball"] as const) {
    test.each([undefined, "packages/example"])(`${sourceKind} reads manifest at %s`, async (safeSubpath) => {
      // Given: a real manifest at the selected root.
      const recipeRoot = safeSubpath === undefined ? root : join(root, safeSubpath);
      await mkdir(recipeRoot, { recursive: true });
      const manifestPath = join(recipeRoot, "recipe.yml");
      const manifestYaml = "id: example\n";
      await writeFile(manifestPath, manifestYaml);
      // When: the cached recipe manifest is resolved.
      const result = await resolveRecipeManifest({
        publishedDir: root,
        safeSubpath,
        sourceKind,
        source: "remote",
        fail,
      });
      // Then: the exact path and bytes are returned.
      expect(result).toEqual({ recipeRoot, manifestPath, manifestYaml });
    });

    test(`${sourceKind} reports a missing subpath manifest`, async () => {
      // Given / When: no manifest at the requested subpath.
      const result = resolveRecipeManifest({
        publishedDir: root,
        safeSubpath: "packages/missing",
        sourceKind,
        source: "remote",
        fail,
      });
      // Then: the remote source retains the subpath diagnostic and remediation.
      await expect(result).rejects.toMatchObject({
        _tag: "RecipeSourceError",
        kind: "subpath-missing",
        source: "remote",
        message: `recipe.yml not found at ${sourceKind} recipe subpath packages/missing.`,
        remediation: "Choose a --path that contains recipe.yml at its top level.",
      });
    });

    test(`${sourceKind} reports a missing top-level manifest`, async () => {
      // Given / When: no manifest at the published root.
      const result = resolveRecipeManifest({
        publishedDir: root,
        safeSubpath: undefined,
        sourceKind,
        source: "remote",
        fail,
      });
      // Then: the manifest error refers to the file rather than the remote source.
      await expect(result).rejects.toMatchObject({
        _tag: "RecipeManifestNotFoundError",
        source: join(root, "recipe.yml"),
        message: `recipe.yml not found at ${join(root, "recipe.yml")}.`,
      });
    });
  }
});
