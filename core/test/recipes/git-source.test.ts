import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RecipeSourceError } from "@lando/sdk/errors";
import { makeGitTransport } from "@lando/source-acquisition/git";

import { resolveGitRecipeSource } from "../../src/recipes/git-source.ts";
import {
  makeGitRecipeTransport,
  makeRecipeTestStateStore,
  makeTestProcessRunner,
  withRecipeSources,
} from "../_support/recipe-source-session.ts";

const VALID_RECIPE = `id: remote-recipe
title: Remote Recipe
description: A git sourced recipe.
version: 0.1.0
config:
  runtime: 4
`;

const withTempRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-git-recipe-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const expectRecipeSourceError = async (
  promise: Promise<unknown>,
  kind: RecipeSourceError["kind"],
): Promise<RecipeSourceError> => {
  try {
    await promise;
    throw new Error(`expected RecipeSourceError kind=${kind}`);
  } catch (cause) {
    expect(cause).toBeInstanceOf(RecipeSourceError);
    if (!(cause instanceof RecipeSourceError)) throw cause;
    expect(cause.kind).toBe(kind);
    return cause;
  }
};

describe("resolveGitRecipeSource", () => {
  test("acquires through the session and resolves recipe.yml under the snapshot root", async () => {
    await withTempRoot(async (dir) => {
      const calls: Array<{ readonly url: string; readonly dest: string }> = [];
      const commitSha = "feedface".repeat(5);
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          git: makeGitRecipeTransport({ calls, manifest: VALID_RECIPE, commitSha }),
        },
        async ({ session }) => {
          const result = await resolveGitRecipeSource({
            url: "https://example.test/recipes.git",
            sources: session,
          });
          expect(calls).toHaveLength(1);
          expect(result.commitSha).toBe(commitSha);
          expect(result.root).toBe(result.acquisitionRoot);
          expect(result.manifestYaml).toContain("id: remote-recipe");
          expect(result.transport).toEqual({ kind: "git", commit: commitSha });
        },
      );
    });
  });

  test("reuses a cached commit without calling the transport again", async () => {
    await withTempRoot(async (dir) => {
      const storeRoot = join(dir, "sources");
      const stateStore = makeRecipeTestStateStore();
      const commitSha = "cafebabe".repeat(5);
      const calls: Array<{ readonly url: string; readonly dest: string }> = [];
      await withRecipeSources(
        {
          root: storeRoot,
          stateStore,
          git: makeGitRecipeTransport({ calls, manifest: VALID_RECIPE, commitSha }),
        },
        async ({ session }) => {
          await resolveGitRecipeSource({
            url: "https://example.test/recipes.git",
            sources: session,
            ref: commitSha,
          });
        },
      );
      expect(calls).toHaveLength(1);
      await withRecipeSources(
        {
          root: storeRoot,
          stateStore,
          git: makeGitRecipeTransport({
            calls,
            fail: new Error("network should not be used"),
            commitSha,
          }),
        },
        async ({ session }) => {
          const result = await resolveGitRecipeSource({
            url: "https://example.test/recipes.git",
            sources: session,
            ref: commitSha,
          });
          expect(result.commitSha).toBe(commitSha);
          expect(calls).toHaveLength(1);
        },
      );
    });
  });

  test("falls back to a stale cached commit when fetch fails and onWarn is set", async () => {
    await withTempRoot(async (dir) => {
      const storeRoot = join(dir, "sources");
      const url = "https://example.test/auth-service.git";
      const commitSha = "a".repeat(40);
      const stateStore = await withRecipeSources(
        {
          root: storeRoot,
          git: makeGitRecipeTransport({ manifest: VALID_RECIPE, commitSha }),
        },
        async ({ session, stateStore }) => {
          await resolveGitRecipeSource({ url, sources: session, ref: "main" });
          return stateStore;
        },
      );
      const warnings: string[] = [];
      await withRecipeSources(
        {
          root: storeRoot,
          stateStore,
          git: makeGitRecipeTransport({ fail: new Error(`Could not resolve host: ${url}`) }),
        },
        async ({ session }) => {
          const result = await resolveGitRecipeSource({
            url,
            sources: session,
            ref: "main",
            onWarn: (message) => {
              warnings.push(message);
            },
          });
          expect(result.commitSha).toBe(commitSha);
          expect(warnings.some((w) => w.includes(commitSha))).toBe(true);
        },
      );
    });
  });

  test("maps auth failures", async () => {
    await withTempRoot(async (dir) => {
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          git: makeGitRecipeTransport({ fail: new Error("Authentication failed") }),
        },
        async ({ session }) => {
          await expectRecipeSourceError(
            resolveGitRecipeSource({
              url: "https://example.test/recipes.git",
              sources: session,
            }),
            "auth",
          );
        },
      );
    });
  });

  test("rejects path traversal in --path", async () => {
    await withTempRoot(async (dir) => {
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          git: makeGitRecipeTransport({ manifest: VALID_RECIPE }),
        },
        async ({ session }) => {
          await expectRecipeSourceError(
            resolveGitRecipeSource({
              url: "https://example.test/recipes.git",
              sources: session,
              path: "../outside",
            }),
            "subpath-invalid",
          );
        },
      );
    });
  });

  test("clones a local bare repo via the default git transport", async () => {
    await withTempRoot(async (dir) => {
      const workspace = join(dir, "workspace");
      const bare = join(dir, "bare.git");
      await mkdir(join(workspace, "packages", "remote-recipe"), { recursive: true });
      await writeFile(join(workspace, "packages", "remote-recipe", "recipe.yml"), VALID_RECIPE);
      const run = async (args: string[], cwd?: string) => {
        const proc = Bun.spawn({
          cmd: ["git", ...args],
          ...(cwd === undefined ? {} : { cwd }),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        if (code !== 0) throw new Error(stderr);
      };
      await run(["init"], workspace);
      await run(["config", "user.email", "test@example.com"], workspace);
      await run(["config", "user.name", "test"], workspace);
      await run(["add", "."], workspace);
      await run(["commit", "-m", "init"], workspace);
      await run(["clone", "--bare", workspace, bare]);

      await withRecipeSources(
        {
          root: join(dir, "sources"),
          git: makeGitTransport(makeTestProcessRunner()),
        },
        async ({ session }) => {
          const result = await resolveGitRecipeSource({
            url: bare,
            sources: session,
            path: "packages/remote-recipe",
          });
          expect(result.manifestYaml).toContain("id: remote-recipe");
          expect(/^[0-9a-f]{40}$/u.test(result.commitSha)).toBe(true);
        },
      );
    });
  });
});
