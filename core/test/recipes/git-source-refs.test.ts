import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeSourceError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { initOptionsFromInput } from "../../src/cli/command-specs/apps/init.ts";
import { parseInitSourceFlags } from "../../src/cli/commands/init-source.ts";
import { type GitRecipeCloneInput, resolveGitRecipeSource } from "../../src/recipes/git-source.ts";
import { flattenRecipe } from "../../src/recipes/manifest/flatten.ts";
import { readRemoteParent } from "../../src/recipes/manifest/parent-source.ts";
import { initAppWithOwnerOnlyFileAccess } from "../_support/private-file-access.ts";

const MANIFEST =
  "id: remote\ntitle: Remote\ndescription: Ref fixture\nversion: 1.0.0\nconfig:\n  runtime: 4\n";
const SHA = "a".repeat(40);
const withRoot = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-recipe-refs-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("recipe git ref propagation", () => {
  for (const input of [
    { source: "github:owner/repo@v1", url: "https://github.com/owner/repo.git" },
    { source: "git+https://example.test/repo.git@v1", url: "https://example.test/repo.git" },
    { source: "git+ssh://git@example.test/repo.git@v1", url: "ssh://git@example.test/repo.git" },
    { source: "git@example.test:repo.git@v1", url: "git@example.test:repo.git" },
    {
      source: "github:owner/repo/packages/base@v1",
      url: "https://github.com/owner/repo.git",
      path: "packages/base",
    },
  ]) {
    test(`passes extends ${input.source} to the cloner with its ref`, async () => {
      // Given
      await withRoot(async (root) => {
        const calls: GitRecipeCloneInput[] = [];
        const gitRecipeCloner = {
          clone: async (cloneInput: GitRecipeCloneInput) => {
            calls.push(cloneInput);
            await mkdir(join(cloneInput.dest, "packages/base"), { recursive: true });
            await writeFile(join(cloneInput.dest, "recipe.yml"), MANIFEST);
            await writeFile(join(cloneInput.dest, "packages/base/recipe.yml"), MANIFEST);
            return { commitSha: SHA };
          },
        };

        // When
        const parent = await Effect.runPromise(
          readRemoteParent(input.source, { userDataRoot: root, gitRecipeCloner }, []),
        );

        // Then
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ url: input.url, ref: "v1" });
        expect(parent.parsed).toMatchObject({ id: "remote" });
        if (input.path !== undefined) expect(parent.source).toContain("packages/base/recipe.yml");
      });
    });
  }

  test("init --url @ref survives native option parsing and reaches the cloner", async () => {
    // Given
    await withRoot(async (root) => {
      const calls: GitRecipeCloneInput[] = [];
      const options = initOptionsFromInput({
        flags: { source: "git", url: "git+https://example.test/repo.git@v1" },
      });

      // When
      const result = initAppWithOwnerOnlyFileAccess({
        ...options,
        cwd: root,
        destination: join(root, "app"),
        userDataRoot: root,
        nonInteractive: true,
        gitRecipeCloner: {
          clone: async (input) => {
            calls.push(input);
            await writeFile(join(input.dest, "recipe.yml"), MANIFEST);
            return { commitSha: SHA };
          },
        },
      });

      // Then
      expect((await result).directory).toBe(join(root, "app"));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: "https://example.test/repo.git", ref: "v1" });
    });
  });

  test("init sends stale-cache warnings to its existing warning sink", async () => {
    // Given
    await withRoot(async (root) => {
      const url = "https://example.test/repo.git";
      await resolveGitRecipeSource({
        url,
        ref: "v1",
        userDataRoot: root,
        gitRecipeCloner: {
          clone: async ({ dest }) => {
            await writeFile(join(dest, "recipe.yml"), MANIFEST);
            return { commitSha: SHA };
          },
        },
      });
      const warnings: string[] = [];

      // When
      const result = initAppWithOwnerOnlyFileAccess({
        cwd: root,
        destination: join(root, "app"),
        full: false,
        source: "git",
        url: `${url}@v1`,
        userDataRoot: root,
        nonInteractive: true,
        onWarn: (warning) => {
          warnings.push(warning);
        },
        gitRecipeCloner: {
          clone: async () => {
            throw new Error("Connection refused");
          },
        },
      });

      // Then
      expect((await result).directory).toBe(join(root, "app"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`${url}@v1`);
      expect(warnings[0]).toContain(SHA);
    });
  });

  test("flatten forwards a caller warning sink to a remote parent", async () => {
    // Given
    await withRoot(async (root) => {
      const url = "https://example.test/repo.git";
      await resolveGitRecipeSource({
        url,
        ref: "v1",
        userDataRoot: root,
        gitRecipeCloner: {
          clone: async ({ dest }) => {
            await writeFile(join(dest, "recipe.yml"), MANIFEST);
            return { commitSha: SHA };
          },
        },
      });
      const warnings: string[] = [];

      // When
      const flattened = await Effect.runPromise(
        flattenRecipe(
          "test://child",
          {
            extends: `git+${url}@v1`,
            id: "child",
            title: "Child",
            description: "Child",
            version: "1.0.0",
            config: {},
          },
          {
            userDataRoot: root,
            onWarn: (warning) => {
              warnings.push(warning);
            },
            gitRecipeCloner: {
              clone: async () => {
                throw new Error("Connection refused");
              },
            },
          },
        ),
      );

      // Then
      expect(flattened.source.id).toBe("child");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`${url}@v1`);
      expect(warnings[0]).toContain(SHA);
    });
  });

  for (const ref of ["-option", "+refspec", "refs/../main", "main:other", "branch name", "v1~1"]) {
    test(`rejects invalid ref ${ref} before acquisition`, async () => {
      // Given
      let calls = 0;
      const gitRecipeCloner = {
        clone: async () => {
          calls += 1;
          return { commitSha: SHA };
        },
      };

      // When
      const acquisition = resolveGitRecipeSource({
        url: "https://example.test/repo.git",
        ref,
        gitRecipeCloner,
      });

      // Then
      await expect(acquisition).rejects.toBeInstanceOf(RecipeSourceError);
      expect(calls).toBe(0);
      expect(() =>
        parseInitSourceFlags({ source: "git", url: `https://example.test/repo.git@${ref}` }),
      ).toThrow(RecipeSourceError);
      await expect(
        Effect.runPromise(readRemoteParent(`github:owner/repo@${ref}`, { gitRecipeCloner }, [])),
      ).rejects.toThrow("Invalid git recipe ref");
      expect(calls).toBe(0);
    });
  }

  for (const commitSha of ["../escape", "abc123", "A".repeat(40), `${"a".repeat(40)}\n`]) {
    test(`rejects unsafe cloner commit ${JSON.stringify(commitSha)}`, async () => {
      // Given
      await withRoot(async (root) => {
        // When
        const acquisition = resolveGitRecipeSource({
          url: "https://example.test/repo.git",
          userDataRoot: root,
          gitRecipeCloner: { clone: async () => ({ commitSha }) },
        });

        // Then
        await expect(acquisition).rejects.toMatchObject({ _tag: "RecipeSourceError", kind: "clone-failed" });
      });
    });
  }
});
