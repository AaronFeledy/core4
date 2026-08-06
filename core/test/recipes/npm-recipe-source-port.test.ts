import { describe, expect, test } from "bun:test";

import { makeNpmRecipeSourcePort } from "../../src/recipes/npm-source.ts";

describe("makeNpmRecipeSourcePort", () => {
  test("parses a package spec and resolves its dist-tag through the registry client", async () => {
    // Given
    const packageNames: string[] = [];
    const port = makeNpmRecipeSourcePort({
      fetchPackument: async (packageName) => {
        packageNames.push(packageName);
        return {
          "dist-tags": { next: "1.2.3" },
          versions: {
            "1.2.3": { dist: { tarball: "https://registry.example/fragments.tgz" } },
          },
        };
      },
    });

    // When
    const resolved = await port.resolve("@acme/fragments@next");

    // Then
    expect(packageNames).toEqual(["@acme/fragments"]);
    expect(resolved).toEqual({
      packageName: "@acme/fragments",
      version: "1.2.3",
      dist: { tarball: "https://registry.example/fragments.tgz" },
    });
  });

  test("missing or non-string tarball fails with RecipeSourceError", async () => {
    // Given
    const port = makeNpmRecipeSourcePort({
      fetchPackument: async () => ({
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": { dist: { tarball: undefined as unknown as string } },
        },
      }),
    });

    // When / Then
    await expect(port.resolve("@acme/fragments@1.0.0")).rejects.toMatchObject({
      _tag: "RecipeSourceError",
      kind: "version-not-found",
    });
  });
});
