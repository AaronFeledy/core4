import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { RecipeManifestNotFoundError, RecipeSourceError } from "@lando/sdk/errors";
import { RecipeManifestService } from "@lando/sdk/services";

import { initApp } from "../../src/cli/commands/init.ts";
import { RecipeManifestServiceLive } from "../../src/recipes/manifest/service.ts";
import { type TarballRecipeFetcher, resolveTarballRecipeSource } from "../../src/recipes/tarball-source.ts";

const VALID_RECIPE = `id: remote-recipe
title: Remote Recipe
description: A tarball sourced recipe.
version: 0.1.0
prompts:
  - name: name
    type: text
    message: App name
    default: tarball-app
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
`;

const withTempRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-tarball-recipe-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * Build a real `.tar.gz` from an in-memory file map using the host `tar`. Keys
 * are archive-relative paths; an explicit empty `recipe.yml` set is allowed for
 * the "missing manifest" cases.
 */
const makeTarball = async (files: Readonly<Record<string, string>>): Promise<Uint8Array> => {
  const stage = await realpath(await mkdtemp(join(tmpdir(), "lando-tarball-build-")));
  const content = join(stage, "content");
  const out = join(stage, "archive.tar.gz");
  try {
    await mkdir(content, { recursive: true });
    for (const [rel, fileContent] of Object.entries(files)) {
      const target = join(content, rel);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, fileContent);
    }
    const proc = Bun.spawn({
      cmd: ["tar", "-czf", out, "-C", content, "."],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`tar failed: ${stderr}`);
    return new Uint8Array(await Bun.file(out).arrayBuffer());
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

const fetcherFor = (bytes: Uint8Array, calls?: Array<string>): TarballRecipeFetcher => ({
  fetch: async (url) => {
    calls?.push(url);
    return bytes;
  },
});

const sha256 = (bytes: Uint8Array): string =>
  require("node:crypto").createHash("sha256").update(bytes).digest("hex");

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected tagged failure");
  return failure.value;
};

describe("resolveTarballRecipeSource", () => {
  test("downloads, extracts, and publishes under userDataRoot/recipe-cache/tarball/<sha256>", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const calls: Array<string> = [];
      const userDataRoot = join(dir, "data");
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        userDataRoot,
        fetcher: fetcherFor(bytes, calls),
      });

      expect(calls).toEqual(["https://example.test/recipe.tar.gz"]);
      expect(result.sha256).toBe(sha256(bytes));
      expect(result.root).toBe(join(userDataRoot, "recipe-cache", "tarball", result.sha256));
      expect(result.source).toBe(join(result.root, "recipe.yml"));
      expect(await Bun.file(result.source).exists()).toBe(true);
      const manifest = await Effect.runPromise(
        Effect.flatMap(RecipeManifestService, (svc) => svc.parse(result.source, result.manifestYaml)).pipe(
          Effect.provide(RecipeManifestServiceLive),
        ),
      );
      expect(manifest.id).toBe("remote-recipe");
    });
  });

  test("cache hit keeps the published dir and re-downloads bytes only to derive the sha", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const userDataRoot = join(dir, "data");
      const published = join(userDataRoot, "recipe-cache", "tarball", sha256(bytes));
      await mkdir(published, { recursive: true });
      await writeFile(join(published, "recipe.yml"), VALID_RECIPE.replace("Remote Recipe", "Cached Recipe"));
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        userDataRoot,
        fetcher: fetcherFor(bytes),
      });
      expect(result.root).toBe(published);
      expect(await Bun.file(result.source).text()).toContain("Cached Recipe");
      const staging = await Array.fromAsync(
        new Bun.Glob(".staging-*").scan({
          cwd: join(userDataRoot, "recipe-cache", "tarball"),
          onlyFiles: false,
        }),
      );
      expect(staging).toEqual([]);
    });
  });

  test("passing a matching --checksum verifies successfully", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        userDataRoot: join(dir, "data"),
        checksum: sha256(bytes),
        fetcher: fetcherFor(bytes),
      });
      expect(result.sha256).toBe(sha256(bytes));
    });
  });

  test("checksum mismatch fails with RecipeSourceError checksum-mismatch and does not extract", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const userDataRoot = join(dir, "data");
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              userDataRoot,
              checksum: "0".repeat(64),
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("checksum-mismatch");
      const published = await Array.fromAsync(
        new Bun.Glob("*").scan({ cwd: join(userDataRoot, "recipe-cache", "tarball"), onlyFiles: false }),
      ).catch(() => []);
      expect(published).toEqual([]);
    });
  });

  test("malformed --checksum (not 64 hex) fails with checksum-mismatch", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              userDataRoot: join(dir, "data"),
              checksum: "not-a-real-hash",
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("checksum-mismatch");
    });
  });

  test("no --checksum warns once and proceeds when no confirm seam is supplied", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const warnings: Array<string> = [];
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        userDataRoot: join(dir, "data"),
        fetcher: fetcherFor(bytes),
        onWarn: (message) => warnings.push(message),
      });
      expect(result.sha256).toBe(sha256(bytes));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(sha256(bytes));
    });
  });

  test("no --checksum with a declined confirm aborts with checksum-unverified", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const seen: Array<string> = [];
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              userDataRoot: join(dir, "data"),
              fetcher: fetcherFor(bytes),
              confirmUnverified: async (hash) => {
                seen.push(hash);
                return false;
              },
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("checksum-unverified");
      expect(seen).toEqual([sha256(bytes)]);
    });
  });

  test("no --checksum with an accepted confirm proceeds", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        userDataRoot: join(dir, "data"),
        fetcher: fetcherFor(bytes),
        confirmUnverified: async () => true,
      });
      expect(result.sha256).toBe(sha256(bytes));
    });
  });

  test("resolves recipe.yml inside a safe monorepo subpath", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "packages/remote-recipe/recipe.yml": VALID_RECIPE });
      const userDataRoot = join(dir, "data");
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        path: "packages/remote-recipe",
        userDataRoot,
        fetcher: fetcherFor(bytes),
      });
      expect(result.root).toBe(
        join(userDataRoot, "recipe-cache", "tarball", result.sha256, "packages", "remote-recipe"),
      );
      expect(await Bun.file(result.source).exists()).toBe(true);
    });
  });

  test.each(["/absolute", "../escape", "safe/../../escape"])("rejects unsafe subpath %s", async (path) => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              path,
              userDataRoot: join(dir, "data"),
              fetcher: fetcherFor(bytes),
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
      const bytes = await makeTarball({ "readme.txt": "no recipe here" });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              userDataRoot: join(dir, "data"),
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      expect(expectFailure(exit)).toBeInstanceOf(RecipeManifestNotFoundError);
    });
  });

  test("missing recipe.yml at a subpath returns RecipeSourceError subpath-missing", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "packages/other/recipe.yml": VALID_RECIPE });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              path: "packages/missing",
              userDataRoot: join(dir, "data"),
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("subpath-missing");
    });
  });

  test("download failure becomes RecipeSourceError download-failed", async () => {
    await withTempRoot(async (dir) => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/missing.tar.gz",
              userDataRoot: join(dir, "data"),
              fetcher: {
                fetch: async () => {
                  throw new Error("HTTP 404 Not Found");
                },
              },
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("download-failed");
    });
  });

  test("non-tar bytes become RecipeSourceError extract-failed", async () => {
    await withTempRoot(async (dir) => {
      const userDataRoot = join(dir, "data");
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              userDataRoot,
              // Gzip magic bytes followed by garbage so gunzip throws.
              fetcher: fetcherFor(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04])),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("extract-failed");
    });
  });
});

describe("initApp tarball source boundary", () => {
  test("tarball recipes reach manifest parsing before the existing non-bundled render limitation", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      let caught: unknown;
      try {
        await initApp({
          cwd: dir,
          full: false,
          source: "tarball",
          url: "https://example.test/recipe.tar.gz",
          userDataRoot: join(dir, "data"),
          tarballRecipeFetcher: fetcherFor(bytes),
          nonInteractive: true,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Recipe file rendering");
      expect((caught as Error).message).toContain("https://example.test/recipe.tar.gz");
    });
  });
});
