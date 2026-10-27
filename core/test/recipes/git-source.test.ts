import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { RecipeManifestNotFoundError, RecipeSourceError } from "@lando/sdk/errors";
import { RecipeManifestService } from "@lando/sdk/services";

import {
  type GitRecipeCloner,
  defaultGitRecipeCloner,
  publish,
  resolveGitRecipeSource,
} from "../../src/recipes/git-source.ts";
import * as RecipeManifestServiceLayer from "../../src/recipes/manifest/service.ts";
import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access.ts";

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
    return { commitSha: options.commitSha ?? "a".repeat(40) };
  },
});

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findErrorOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected tagged failure");
  return failure.value;
};

describe("resolveGitRecipeSource", () => {
  for (const structuredAuth of [false, true]) {
    test(`cached recipe ${structuredAuth ? "never hides a structured auth failure" : "cannot fall back without a warning sink"}`, async () => {
      // Given
      await withTempRoot(async (dir) => {
        const url = "https://example.test/recipes.git";
        const userDataRoot = join(dir, "data");
        await resolveGitRecipeSource({
          url,
          userDataRoot,
          gitRecipeCloner: makeCloner({ manifest: VALID_RECIPE }),
        });
        const warnings: string[] = [];
        const failure = structuredAuth
          ? new RecipeSourceError({
              message: "Access rejected",
              source: url,
              kind: "auth",
              remediation: "Sign in again.",
            })
          : new Error("Connection refused");
        // When
        const acquisition = resolveGitRecipeSource({
          url,
          userDataRoot,
          gitRecipeCloner: makeCloner({ fail: failure }),
          ...(structuredAuth
            ? {
                onWarn: (warning: string) => {
                  warnings.push(warning);
                },
              }
            : {}),
        });
        // Then
        await expect(acquisition).rejects.toMatchObject({
          _tag: "RecipeSourceError",
          kind: structuredAuth ? "auth" : "clone-failed",
        });
        expect(warnings).toEqual([]);
      });
    });
  }

  test("clones through the seam and publishes under userDataRoot/recipe-cache/git/<commitSha>", async () => {
    await withTempRoot(async (dir) => {
      const calls: Array<{ readonly url: string; readonly stagingDir: string }> = [];
      const userDataRoot = join(dir, "data");
      const result = await resolveGitRecipeSource({
        url: "https://example.test/recipes.git",
        userDataRoot,
        gitRecipeCloner: makeCloner({ calls, manifest: VALID_RECIPE, commitSha: "feedface".repeat(5) }),
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://example.test/recipes.git");
      expect(calls[0]?.stagingDir).toContain(join(userDataRoot, "recipe-cache", "git", ".staging-"));
      expect(result.root).toBe(join(userDataRoot, "recipe-cache", "git", "feedface".repeat(5)));
      if (result.root === undefined) throw new Error("expected a cached recipe root");
      expect(result.source).toBe(join(result.root, "recipe.yml"));
      expect(result.commitSha).toBe("feedface".repeat(5));
      expect(await Bun.file(result.source).exists()).toBe(true);
    });
  });

  test("cache hit keeps the existing published dir and discards staging", async () => {
    await withTempRoot(async (dir) => {
      const userDataRoot = join(dir, "data");
      const published = join(userDataRoot, "recipe-cache", "git", "cafebabe".repeat(5));
      const calls: Array<{ readonly url: string; readonly stagingDir: string }> = [];
      await mkdir(published, { recursive: true });
      await writeFile(join(published, "recipe.yml"), VALID_RECIPE.replace("Remote Recipe", "Cached Recipe"));
      const result = await resolveGitRecipeSource({
        url: "https://example.test/recipes.git",
        userDataRoot,
        gitRecipeCloner: makeCloner({ calls, manifest: VALID_RECIPE, commitSha: "cafebabe".repeat(5) }),
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

  test("EXDEV publish fallback treats a concurrently-created published dir as success", async () => {
    await withTempRoot(async (dir) => {
      const staging = join(dir, "staging");
      const published = join(dir, "published");
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, "recipe.yml"), VALID_RECIPE);
      const exdev = Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
      const exists = Object.assign(new Error("destination exists"), { code: "EEXIST" });

      await publish(staging, published, {
        rename: async () => {
          throw exdev;
        },
        cp: async () => {
          await mkdir(published, { recursive: true });
          await writeFile(
            join(published, "recipe.yml"),
            VALID_RECIPE.replace("Remote Recipe", "Cached Recipe"),
          );
          throw exists;
        },
        rm,
        fileExists: async (path) =>
          stat(path).then(
            () => true,
            () => false,
          ),
      });

      expect(await Bun.file(staging).exists()).toBe(false);
      expect(await Bun.file(join(published, "recipe.yml")).text()).toContain("Cached Recipe");
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
          Effect.provide(RecipeManifestServiceLayer.layer),
        ),
      );

      expect(result.root).toBe(
        join(userDataRoot, "recipe-cache", "git", "a".repeat(40), "packages", "remote-recipe"),
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
      expect(failure).toMatchObject({
        source: path,
        message:
          path === "/absolute"
            ? `Git recipe --path must be relative and stay inside the cloned repository: ${path}`
            : `Git recipe --path escapes the cloned repository: ${path}`,
        remediation: "Pass a relative path inside the repository, such as --path=packages/foo.",
      });
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
      const manifestPath = join(dir, "data", "recipe-cache", "git", "a".repeat(40), "recipe.yml");
      expect(expectFailure(exit)).toMatchObject({
        message: `recipe.yml not found at ${manifestPath}.`,
        source: manifestPath,
      });
      expect(expectFailure(exit)).toHaveProperty(
        "remediation",
        "Point the recipe source at a directory containing recipe.yml or recipe.ts.",
      );
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
      expect(failure).toMatchObject({
        source: "https://example.test/recipes.git",
        message: "recipe.yml not found at git recipe subpath packages/missing.",
        remediation: "Choose a --path that contains recipe.yml at its top level.",
      });
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
  const runGit = async (args: ReadonlyArray<string>, cwd: string): Promise<string> => {
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
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
    return stdout.trim();
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
          Effect.provide(RecipeManifestServiceLayer.layer),
        ),
      );
      expect(manifest.id).toBe("remote-recipe");
    });
  });

  for (const selector of [
    "annotated-tag",
    "branch",
    "full-sha",
    "default",
    "unknown",
    "abbreviated-sha",
  ] as const) {
    test(`default cloner acquires ${selector} through shallow fetch`, async () => {
      await withTempRoot(async (dir) => {
        // Given
        const worktree = join(dir, "worktree");
        await mkdir(worktree);
        await runGit(["init", "-q", "-b", "main"], worktree);
        await Bun.write(join(worktree, "fragment.yml"), "services: {}\n");
        await runGit(["add", "."], worktree);
        await runGit(["commit", "-q", "-m", "first"], worktree);
        const first = await runGit(["rev-parse", "HEAD"], worktree);
        await runGit(["tag", "-a", "v1", "-m", "annotated"], worktree);
        await runGit(["branch", "release"], worktree);
        await Bun.write(join(worktree, "fragment.yml"), "services: {web: {type: php}}\n");
        await runGit(["commit", "-q", "-am", "second"], worktree);
        const tip = await runGit(["rev-parse", "HEAD"], worktree);
        const bare = join(dir, "remote.git");
        await runGit(["clone", "-q", "--bare", worktree, bare], dir);
        const refs = {
          "annotated-tag": "v1",
          branch: "release",
          "full-sha": first,
          default: undefined,
          unknown: "absent",
          "abbreviated-sha": first.slice(0, 8),
        };
        const ref = refs[selector];
        const dest = join(dir, "acquired");
        // When
        const acquisition = defaultGitRecipeCloner.clone({
          url: `file://${bare}`,
          dest,
          stagingDir: dest,
          ...(ref === undefined ? {} : { ref }),
        });
        // Then
        if (selector === "unknown" || selector === "abbreviated-sha") {
          await expect(acquisition).rejects.toThrow("couldn't find remote ref");
        } else {
          expect((await acquisition).commitSha).toBe(selector === "default" ? tip : first);
          expect(await Bun.file(join(dest, "fragment.yml")).text()).toBe(
            selector === "default" ? "services: {web: {type: php}}\n" : "services: {}\n",
          );
          expect(await runGit(["rev-parse", "--is-shallow-repository"], dest)).toBe("true");
        }
      });
    });
  }
});
