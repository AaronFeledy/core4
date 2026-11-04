import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeSourceError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { parseInitSourceFlags } from "../../src/cli/commands/init-source.ts";
import { resolveGitRecipeSource } from "../../src/recipes/git-source.ts";
import { flattenRecipe } from "../../src/recipes/manifest/flatten.ts";
import { readRemoteParent } from "../../src/recipes/manifest/parent-source.ts";
import { makeGitRecipeTransport, withRecipeSources } from "../_support/recipe-source-session.ts";

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
    test(`passes extends ${input.source} to the transport with its ref`, async () => {
      await withRoot(async (root) => {
        const calls: Array<{ readonly url: string; readonly ref?: string; readonly dest: string }> = [];
        await withRecipeSources(
          {
            root: join(root, "sources"),
            git: makeGitRecipeTransport({
              calls,
              commitSha: SHA,
              manifest: MANIFEST,
              ...(input.path === undefined ? {} : { subpath: input.path }),
            }),
          },
          async ({ session }) => {
            await Effect.runPromise(readRemoteParent(input.source, { sources: session }, []));
            expect(calls[0]?.url).toBe(input.url);
            expect(calls[0]?.ref).toBe("v1");
          },
        );
      });
    });
  }

  test("init --url @ref survives native option parsing and reaches the transport", async () => {
    await withRoot(async (root) => {
      const flags = parseInitSourceFlags({
        source: "git",
        url: "https://example.test/repo.git@v2",
      });
      expect(flags.ref).toBe("v2");
      expect(flags.url).toBe("https://example.test/repo.git");
      const calls: Array<{ readonly url: string; readonly ref?: string }> = [];
      await withRecipeSources(
        {
          root: join(root, "sources"),
          git: makeGitRecipeTransport({ calls, commitSha: SHA, manifest: MANIFEST }),
        },
        async ({ session }) => {
          await resolveGitRecipeSource({
            url: flags.url ?? "",
            sources: session,
            ...(flags.ref === undefined ? {} : { ref: flags.ref }),
          });
          expect(calls.some((c) => c.ref === "v2")).toBe(true);
        },
      );
    });
  });

  test("resolveGitRecipeSource forwards ref to the transport", async () => {
    await withRoot(async (root) => {
      const calls: Array<{ readonly ref?: string }> = [];
      await withRecipeSources(
        {
          root: join(root, "sources"),
          git: makeGitRecipeTransport({ calls, commitSha: SHA, manifest: MANIFEST }),
        },
        async ({ session }) => {
          await resolveGitRecipeSource({
            url: "https://example.test/repo.git",
            ref: "release",
            sources: session,
          });
          expect(calls[0]?.ref).toBe("release");
        },
      );
    });
  });

  test("flattenRecipe remote parent uses the session", async () => {
    await withRoot(async (root) => {
      const calls: Array<{ readonly url: string; readonly ref?: string }> = [];
      await withRecipeSources(
        {
          root: join(root, "sources"),
          git: makeGitRecipeTransport({ calls, commitSha: SHA, manifest: MANIFEST }),
        },
        async ({ session }) => {
          await Effect.runPromise(
            flattenRecipe(
              join(root, "child.yml"),
              {
                id: "child",
                title: "Child",
                description: "c",
                version: "1.0.0",
                extends: "github:owner/repo@v9",
                config: { runtime: 4 },
              },
              { sources: session },
            ),
          );
          expect(calls[0]?.ref).toBe("v9");
        },
      );
    });
  });

  for (const ref of ["feat/../x", "bad space"]) {
    test(`rejects unsafe ref ${JSON.stringify(ref)}`, async () => {
      await withRoot(async (root) => {
        await withRecipeSources(
          {
            root: join(root, "sources"),
            git: makeGitRecipeTransport({ commitSha: SHA, manifest: MANIFEST }),
          },
          async ({ session }) => {
            await expect(
              Effect.runPromise(readRemoteParent(`github:owner/repo@${ref}`, { sources: session }, [])),
            ).rejects.toBeInstanceOf(RecipeSourceError);
          },
        );
      });
    });
  }

  test("rejects unsafe transport commit", async () => {
    await withRoot(async (root) => {
      await withRecipeSources(
        {
          root: join(root, "sources"),
          git: makeGitRecipeTransport({ commitSha: "short", manifest: MANIFEST }),
        },
        async ({ session }) => {
          await expect(
            resolveGitRecipeSource({
              url: "https://example.test/repo.git",
              sources: session,
            }),
          ).rejects.toBeInstanceOf(RecipeSourceError);
        },
      );
    });
  });
});
