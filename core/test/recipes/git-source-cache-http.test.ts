import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeGitTransport } from "@lando/source-acquisition/git";
import { resolveGitRecipeSource } from "../../src/recipes/git-source.ts";
import { createGitRepository } from "../_support/git-repository.ts";
import {
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

describe("resolveGitRecipeSource bare-repo cache", () => {
  test("floating refs acquire and full-SHA hits reuse the published tree", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-git-cache-")));
    try {
      const repo = await createGitRepository(root, "recipes.git", [
        { kind: "commit", files: { "recipe.yml": VALID_RECIPE }, message: "init" },
      ]);
      const stateStore = makeRecipeTestStateStore();
      await withRecipeSources(
        {
          root: join(root, "sources"),
          stateStore,
          git: makeGitTransport(makeTestProcessRunner()),
        },
        async ({ session }) => {
          const first = await resolveGitRecipeSource({
            url: repo.bare,
            sources: session,
            ref: "main",
          });
          expect(/^[0-9a-f]{40}$/u.test(first.commitSha)).toBe(true);
          const again = await resolveGitRecipeSource({
            url: repo.bare,
            sources: session,
            ref: first.commitSha,
          });
          expect(again.commitSha).toBe(first.commitSha);
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
