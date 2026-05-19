import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { NotImplementedError, RecipeManifestNotFoundError } from "@lando/sdk/errors";

import {
  nodePostgresRecipeSource,
  nodePostgresRecipeYaml,
} from "../../src/recipes/builtin/node-postgres/manifest.ts";
import { resolveRecipeRef } from "../../src/recipes/source.ts";

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-recipe-source-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runResolve = async (ref: string, cwd: string) => Effect.runPromiseExit(resolveRecipeRef(ref, { cwd }));

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected tagged failure");
  return failure.value;
};

describe("resolveRecipeRef — built-in (bundled) discovery (§8.8.4)", () => {
  test("bare id resolves to the bundled node-postgres recipe", async () => {
    const exit = await runResolve("node-postgres", process.cwd());
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.id).toBe("node-postgres");
    expect(exit.value.source).toBe(nodePostgresRecipeSource);
    expect(exit.value.manifestYaml).toBe(nodePostgresRecipeYaml);
    expect(exit.value.root).toBeUndefined();
  });

  test("unknown bare id fails with RecipeManifestNotFoundError listing known ids", async () => {
    const exit = await runResolve("definitely-not-a-real-recipe", process.cwd());
    const failure = expectFailure(exit);
    expect(failure).toBeInstanceOf(RecipeManifestNotFoundError);
    if (failure instanceof RecipeManifestNotFoundError) {
      expect(failure.source).toBe("definitely-not-a-real-recipe");
      expect(failure.message).toContain('Unknown built-in recipe "definitely-not-a-real-recipe"');
      expect(failure.message).toContain("node-postgres");
    }
  });
});

describe("resolveRecipeRef — local cwd discovery (§8.8.4)", () => {
  test("./relative path resolves recipe.yml under that directory", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "my-recipe");
      await Bun.write(
        join(recipeDir, "recipe.yml"),
        `id: my-recipe
title: My Recipe
description: A local recipe.
version: 0.0.1
`,
      );

      const exit = await runResolve("./my-recipe", dir);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      expect(exit.value.id).toBe("./my-recipe");
      expect(exit.value.source).toBe(resolve(recipeDir, "recipe.yml"));
      expect(exit.value.root).toBe(recipeDir);
      expect(exit.value.manifestYaml).toContain("id: my-recipe");
    });
  });

  test("absolute path resolves recipe.yml under that directory", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "abs-recipe");
      await Bun.write(
        join(recipeDir, "recipe.yml"),
        `id: abs-recipe
title: Absolute
description: Resolved via absolute path.
version: 0.0.1
`,
      );

      const exit = await runResolve(recipeDir, "/tmp");
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      expect(exit.value.source).toBe(resolve(recipeDir, "recipe.yml"));
      expect(exit.value.root).toBe(recipeDir);
    });
  });

  test("local path missing recipe.yml fails with RecipeManifestNotFoundError", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "empty");
      await writeFile(join(dir, "marker"), "");
      await rm(join(dir, "marker"));
      await Bun.write(join(recipeDir, ".keep"), "");
      const exit = await runResolve("./empty", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeManifestNotFoundError);
      if (failure instanceof RecipeManifestNotFoundError) {
        expect(failure.source).toBe(resolve(recipeDir, "recipe.yml"));
        expect(failure.message).toContain("recipe.yml not found");
      }
    });
  });
});

describe("resolveRecipeRef — deferred remote sources (§8.8.4)", () => {
  const REMOTE_REFS: ReadonlyArray<{ readonly scheme: string; readonly ref: string }> = [
    { scheme: "github", ref: "github:lando/wordpress" },
    { scheme: "github", ref: "github:lando/wordpress/path@main" },
    { scheme: "git", ref: "git+https://example.test/repo.git" },
    { scheme: "git", ref: "git+ssh://git@example.test/repo.git" },
    { scheme: "git", ref: "git@example.test:lando/wordpress.git" },
    { scheme: "git", ref: "git://example.test/repo.git" },
    { scheme: "npm", ref: "npm:@lando/recipe-wordpress" },
    { scheme: "npm", ref: "npm:@lando/recipe-wordpress@1.2.3" },
    { scheme: "registry", ref: "registry:wordpress" },
    { scheme: "registry", ref: "registry:wordpress@1.0.0" },
  ];

  for (const { scheme, ref } of REMOTE_REFS) {
    test(`${ref} fails with NotImplementedError + Beta remediation`, async () => {
      const exit = await runResolve(ref, process.cwd());
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(NotImplementedError);
      if (failure instanceof NotImplementedError) {
        expect(failure.commandId).toBe("recipe.source.resolve");
        expect(failure.specSection).toBe("§8.8.4");
        expect(failure.remediation).toContain("deferred to the Beta release");
        expect(failure.message).toContain(`"${scheme}"`);
        expect(failure.message).toContain(`"${ref}"`);
      }
    });
  }
});

describe("resolveRecipeRef — determinism (no network access)", () => {
  test("resolution does not perform any network IO (no spawned curl/wget/git/etc.)", async () => {
    // Sentinel: replace global fetch with one that throws if called.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network IO is not allowed during recipe source resolution");
    }) as typeof fetch;
    try {
      const exit = await runResolve("node-postgres", process.cwd());
      expect(Exit.isSuccess(exit)).toBe(true);

      const remoteExit = await runResolve("github:lando/wordpress", process.cwd());
      const failure = expectFailure(remoteExit);
      expect(failure).toBeInstanceOf(NotImplementedError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("resolveRecipeRef — malformed inputs", () => {
  test("empty string fails with NotImplementedError", async () => {
    const exit = await runResolve("", process.cwd());
    const failure = expectFailure(exit);
    expect(failure).toBeInstanceOf(NotImplementedError);
  });

  test("ref with uppercase letters falls through to unsupported scheme", async () => {
    const exit = await runResolve("NotABuiltinId", process.cwd());
    const failure = expectFailure(exit);
    expect(failure).toBeInstanceOf(NotImplementedError);
    if (failure instanceof NotImplementedError) {
      expect(failure.message).toContain('"unknown"');
    }
  });
});
