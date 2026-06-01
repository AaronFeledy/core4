import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { RecipeSourceError } from "@lando/sdk/errors";
import type { RecipeRegistryResponse } from "@lando/sdk/schema";

import { initApp } from "../../src/cli/commands/init.ts";

import {
  DEFAULT_RECIPE_REGISTRY_URL,
  type RecipeRegistryClient,
  resolveRegistryRecipeSource,
} from "../../src/recipes/registry-source.ts";
import type { TarballRecipeFetcher } from "../../src/recipes/tarball-source.ts";

const VALID_RECIPE = `id: registry-recipe
title: Registry Recipe
description: A registry sourced recipe.
version: 0.1.0
prompts:
  - name: name
    type: text
    message: App name
    default: registry-app
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
`;

const withTempRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-registry-recipe-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const text = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

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
  const [code, stderr] = await Promise.all([proc.exited, text(proc.stderr)]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
};

const makeGitRepo = async (
  dir: string,
  files: Readonly<Record<string, string>> = { "recipe.yml": VALID_RECIPE },
): Promise<string> => {
  const worktree = join(dir, "worktree");
  await mkdir(worktree, { recursive: true });
  for (const [rel, fileContent] of Object.entries(files)) {
    const target = join(worktree, rel);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, fileContent);
  }
  await runGit(["init", "-b", "main"], worktree);
  await runGit(["add", "."], worktree);
  await runGit(["commit", "-m", "add recipe"], worktree);
  const bare = join(dir, "remote.git");
  await runGit(["clone", "--bare", worktree, bare], dir);
  return bare;
};

const makeTopLevelTarball = async (files: Readonly<Record<string, string>>): Promise<Uint8Array> => {
  const stage = await realpath(await mkdtemp(join(tmpdir(), "lando-registry-build-")));
  const out = join(stage, "archive.tgz");
  try {
    for (const [rel, fileContent] of Object.entries(files)) {
      const target = join(stage, rel);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, fileContent);
    }
    const proc = Bun.spawn({
      cmd: ["tar", "-czf", out, "-C", stage, ...Object.keys(files)],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, text(proc.stderr)]);
    if (code !== 0) throw new Error(`tar failed: ${stderr}`);
    return new Uint8Array(await Bun.file(out).arrayBuffer());
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

const clientFor = (response: RecipeRegistryResponse | undefined): RecipeRegistryClient => ({
  fetchResolution: async () => response,
});

const fetcherFor = (bytes: Uint8Array, calls?: Array<string>): TarballRecipeFetcher => ({
  fetch: async (url) => {
    calls?.push(url);
    return bytes;
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

describe("resolveRegistryRecipeSource", () => {
  test("delegates git resolutions to the git recipe source resolver", async () => {
    await withTempRoot(async (dir) => {
      const registryId = "registry-git";
      const bare = await makeGitRepo(dir);
      const userDataRoot = join(dir, "data");

      const result = await resolveRegistryRecipeSource({
        id: registryId,
        userDataRoot,
        registryClient: clientFor({ id: registryId, resolution: { kind: "git", url: `file://${bare}` } }),
      });

      expect(result.id).toBe(registryId);
      expect(result.source.endsWith("recipe.yml")).toBe(true);
      expect(result.manifestYaml).toContain("Registry Recipe");
      expect(result.root).toBeDefined();
    });
  });

  test("forwards an explicit registry source path to the underlying git resolver", async () => {
    await withTempRoot(async (dir) => {
      const registryId = "registry-git-subpath";
      const bare = await makeGitRepo(dir, { "recipes/registry/recipe.yml": VALID_RECIPE });

      const result = await resolveRegistryRecipeSource({
        id: registryId,
        path: "recipes/registry",
        userDataRoot: join(dir, "data"),
        registryClient: clientFor({ id: registryId, resolution: { kind: "git", url: `file://${bare}` } }),
      });

      expect(result.id).toBe(registryId);
      expect(result.source.endsWith("recipes/registry/recipe.yml")).toBe(true);
      expect(result.manifestYaml).toContain("Registry Recipe");
    });
  });

  test("delegates tarball resolutions to the tarball recipe source resolver", async () => {
    await withTempRoot(async (dir) => {
      const registryId = "registry-tarball";
      const bytes = await makeTopLevelTarball({ "recipe.yml": VALID_RECIPE });
      const fetchCalls: Array<string> = [];

      const result = await resolveRegistryRecipeSource({
        id: registryId,
        userDataRoot: join(dir, "data"),
        registryClient: clientFor({
          id: registryId,
          resolution: { kind: "tarball", url: "https://example.test/r.tgz" },
        }),
        tarballRecipeFetcher: fetcherFor(bytes, fetchCalls),
      });

      expect(fetchCalls).toEqual(["https://example.test/r.tgz"]);
      expect(result.id).toBe(registryId);
      expect(result.source.endsWith("recipe.yml")).toBe(true);
      expect(result.manifestYaml).toContain("Registry Recipe");
      expect(result.root).toBeDefined();
    });
  });

  test("missing registry ids fail with recipe-not-found", async () => {
    await withTempRoot(async (dir) => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveRegistryRecipeSource({
              id: "missing-recipe",
              userDataRoot: join(dir, "data"),
              registryClient: clientFor(undefined),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("recipe-not-found");
    });
  });

  test("invalid registry payloads fail with registry-invalid", async () => {
    await withTempRoot(async (dir) => {
      const invalid = {
        id: "bad",
        resolution: { kind: "svn", url: "x" },
      } as unknown as RecipeRegistryResponse;
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveRegistryRecipeSource({
              id: "bad",
              userDataRoot: join(dir, "data"),
              registryClient: clientFor(invalid),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("registry-invalid");
    });
  });

  test("registry fetch failures fail with registry-failed", async () => {
    await withTempRoot(async (dir) => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveRegistryRecipeSource({
              id: "network-failure",
              userDataRoot: join(dir, "data"),
              registryClient: {
                fetchResolution: async () => {
                  throw new Error("ECONNREFUSED");
                },
              },
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("registry-failed");
    });
  });
});

describe("initApp registry source boundary", () => {
  test("registry init forwards --path to the registry resolver", async () => {
    await withTempRoot(async (dir) => {
      const registryId = "registry-init-subpath";
      const bare = await makeGitRepo(dir, { "recipes/registry/recipe.yml": VALID_RECIPE });
      let caught: unknown;
      try {
        await initApp({
          cwd: dir,
          full: false,
          source: "registry",
          id: registryId,
          path: "recipes/registry",
          registryClient: clientFor({ id: registryId, resolution: { kind: "git", url: `file://${bare}` } }),
          userDataRoot: join(dir, "data"),
          nonInteractive: true,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Recipe file rendering");
      expect((caught as Error).message).toContain(registryId);
    });
  });

  test("registry git recipes reach manifest parsing before the existing non-bundled render limitation", async () => {
    await withTempRoot(async (dir) => {
      const registryId = "registry-init-git";
      const bare = await makeGitRepo(dir);
      let caught: unknown;
      try {
        await initApp({
          cwd: dir,
          full: false,
          source: "registry",
          id: registryId,
          registryClient: clientFor({ id: registryId, resolution: { kind: "git", url: `file://${bare}` } }),
          userDataRoot: join(dir, "data"),
          nonInteractive: true,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Recipe file rendering");
      expect((caught as Error).message).toContain(registryId);
    });
  });
});

describe("resolveRegistryRecipeSource — live registry", () => {
  const liveTest = process.env.LANDO_REGISTRY_E2E === "1" ? test : test.skip;

  liveTest("resolves a recipe from the default registry", async () => {
    const result = await resolveRegistryRecipeSource({ id: "lamp" });
    expect(result.id).toBe("lamp");
    expect(DEFAULT_RECIPE_REGISTRY_URL).toBe("https://registry.lando.dev/recipes/");
  });
});
