import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { RecipeManifestNotFoundError, RecipeSourceError } from "@lando/sdk/errors";
import { RecipeManifestService } from "@lando/sdk/services";

import { initApp } from "../../src/cli/commands/init.ts";
import { type GitRecipeCloner, resolveGitRecipeSource } from "../../src/recipes/git-source.ts";
import { RecipeManifestServiceLive } from "../../src/recipes/manifest/service.ts";

const VALID_RECIPE = `id: remote-recipe
title: Remote Recipe
description: A git sourced recipe.
version: 0.1.0
prompts:
  - name: name
    type: text
    message: App name
    default: git-app
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
`;

const withTempRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-git-recipe-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const makeCloner = (
  options: {
    readonly commitSha?: string;
    readonly subpath?: string;
    readonly manifest?: string;
    readonly fail?: unknown;
    readonly calls?: Array<{ readonly url: string; readonly stagingDir: string }>;
  } = {},
): GitRecipeCloner => ({
  clone: async ({ url, stagingDir }) => {
    options.calls?.push({ url, stagingDir });
    if (options.fail !== undefined) throw options.fail;
    const recipeRoot = options.subpath === undefined ? stagingDir : join(stagingDir, options.subpath);
    await mkdir(recipeRoot, { recursive: true });
    if (options.manifest !== undefined) await writeFile(join(recipeRoot, "recipe.yml"), options.manifest);
    return { commitSha: options.commitSha ?? "abc123def456" };
  },
});

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected tagged failure");
  return failure.value;
};

describe("resolveGitRecipeSource", () => {
  test("clones through the seam and publishes under userDataRoot/recipe-cache/git/<commitSha>", async () => {
    await withTempRoot(async (dir) => {
      const calls: Array<{ readonly url: string; readonly stagingDir: string }> = [];
      const userDataRoot = join(dir, "data");
      const result = await resolveGitRecipeSource({
        url: "https://example.test/recipes.git",
        userDataRoot,
        gitRecipeCloner: makeCloner({ calls, manifest: VALID_RECIPE, commitSha: "feedface" }),
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://example.test/recipes.git");
      expect(calls[0]?.stagingDir).toContain(join(userDataRoot, "recipe-cache", "git", ".staging-"));
      expect(result.root).toBe(join(userDataRoot, "recipe-cache", "git", "feedface"));
      expect(result.source).toBe(join(result.root, "recipe.yml"));
      expect(result.commitSha).toBe("feedface");
      expect(await Bun.file(result.source).exists()).toBe(true);
    });
  });

  test("cache hit keeps the existing published dir and discards staging", async () => {
    await withTempRoot(async (dir) => {
      const userDataRoot = join(dir, "data");
      const published = join(userDataRoot, "recipe-cache", "git", "cafebabe");
      const calls: Array<{ readonly url: string; readonly stagingDir: string }> = [];
      await mkdir(published, { recursive: true });
      await writeFile(join(published, "recipe.yml"), VALID_RECIPE.replace("Remote Recipe", "Cached Recipe"));
      const result = await resolveGitRecipeSource({
        url: "https://example.test/recipes.git",
        userDataRoot,
        gitRecipeCloner: makeCloner({ calls, manifest: VALID_RECIPE, commitSha: "cafebabe" }),
      });

      expect(calls).toHaveLength(1);
      expect(result.root).toBe(published);
      expect(await Bun.file(join(published, "recipe.yml")).text()).toContain("Cached Recipe");
      const staging = await Array.fromAsync(
        new Bun.Glob(".staging-*").scan({ cwd: join(userDataRoot, "recipe-cache", "git"), onlyFiles: false }),
      );
      expect(staging).toEqual([]);
    });
  });

  test("resolves recipe.yml inside a safe monorepo subpath and parses the manifest", async () => {
    await withTempRoot(async (dir) => {
      const userDataRoot = join(dir, "data");
      const result = await resolveGitRecipeSource({
        url: "https://example.test/recipes.git",
        path: "packages/remote-recipe",
        userDataRoot,
        gitRecipeCloner: makeCloner({ subpath: "packages/remote-recipe", manifest: VALID_RECIPE }),
      });
      const manifest = await Effect.runPromise(
        Effect.flatMap(RecipeManifestService, (svc) => svc.parse(result.source, result.manifestYaml)).pipe(
          Effect.provide(RecipeManifestServiceLive),
        ),
      );

      expect(result.root).toBe(
        join(userDataRoot, "recipe-cache", "git", "abc123def456", "packages", "remote-recipe"),
      );
      expect(manifest.id).toBe("remote-recipe");
    });
  });

  test.each(["/absolute", "../escape", "safe/../../escape"])("rejects unsafe subpath %s", async (path) => {
    await withTempRoot(async (dir) => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveGitRecipeSource({
              url: "https://example.test/recipes.git",
              path,
              userDataRoot: join(dir, "data"),
              gitRecipeCloner: makeCloner({ manifest: VALID_RECIPE }),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("subpath-invalid");
    });
  });

  test("missing top-level recipe.yml uses RecipeManifestNotFoundError", async () => {
    await withTempRoot(async (dir) => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveGitRecipeSource({
              url: "https://example.test/recipes.git",
              userDataRoot: join(dir, "data"),
              gitRecipeCloner: makeCloner(),
            }),
          catch: (cause) => cause,
        }),
      );
      expect(expectFailure(exit)).toBeInstanceOf(RecipeManifestNotFoundError);
    });
  });

  test("missing recipe.yml at a subpath returns RecipeSourceError subpath-missing", async () => {
    await withTempRoot(async (dir) => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveGitRecipeSource({
              url: "https://example.test/recipes.git",
              path: "packages/missing",
              userDataRoot: join(dir, "data"),
              gitRecipeCloner: makeCloner({ subpath: "packages/missing" }),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("subpath-missing");
    });
  });

  test("clone failures become RecipeSourceError with clone/auth remediation", async () => {
    await withTempRoot(async (dir) => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveGitRecipeSource({
              url: "git@example.test:private/repo.git",
              userDataRoot: join(dir, "data"),
              gitRecipeCloner: makeCloner({ fail: new Error("Authentication failed") }),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) {
        expect(failure.kind).toBe("auth");
        expect(failure.remediation).toContain("credentials");
      }
    });
  });
});

describe("initApp git source boundary", () => {
  test("git recipes reach manifest parsing and prompt defaults before the existing non-bundled render limitation", async () => {
    await withTempRoot(async (dir) => {
      let caught: unknown;
      try {
        await initApp({
          cwd: dir,
          full: false,
          source: "git",
          url: "https://example.test/recipes.git",
          userDataRoot: join(dir, "data"),
          gitRecipeCloner: makeCloner({ manifest: VALID_RECIPE }),
          nonInteractive: true,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Recipe file rendering");
      expect((caught as Error).message).toContain("https://example.test/recipes.git");
    });
  });
});

describe("resolveGitRecipeSource — real git clone (file:// source, no network)", () => {
  const runGit = async (args: ReadonlyArray<string>, cwd: string): Promise<void> => {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Lando Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Lando Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  };

  test("clones a local bare repo and resolves recipe.yml at a subpath via the default cloner", async () => {
    await withTempRoot(async (dir) => {
      const worktree = join(dir, "worktree");
      const recipeDir = join(worktree, "packages", "remote-recipe");
      await mkdir(recipeDir, { recursive: true });
      await writeFile(join(recipeDir, "recipe.yml"), VALID_RECIPE);
      await runGit(["init", "-b", "main"], worktree);
      await runGit(["add", "."], worktree);
      await runGit(["commit", "-m", "add recipe"], worktree);
      const bare = join(dir, "remote.git");
      await runGit(["clone", "--bare", worktree, bare], dir);

      const userDataRoot = join(dir, "data");
      const result = await resolveGitRecipeSource({
        url: `file://${bare}`,
        path: "packages/remote-recipe",
        userDataRoot,
      });

      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/u);
      expect(result.root).toBe(
        join(userDataRoot, "recipe-cache", "git", result.commitSha, "packages", "remote-recipe"),
      );
      expect(await Bun.file(result.source).exists()).toBe(true);
      const manifest = await Effect.runPromise(
        Effect.flatMap(RecipeManifestService, (svc) => svc.parse(result.source, result.manifestYaml)).pipe(
          Effect.provide(RecipeManifestServiceLive),
        ),
      );
      expect(manifest.id).toBe("remote-recipe");
    });
  });
});
