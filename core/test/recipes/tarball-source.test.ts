import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RecipeSourceError } from "@lando/sdk/errors";

import { resolveTarballRecipeSource } from "../../src/recipes/tarball-source.ts";
import { makeArchiveTransportForBytes, withRecipeSources } from "../_support/recipe-source-session.ts";

const VALID_RECIPE = `id: remote-recipe
title: Remote Recipe
description: A tarball sourced recipe.
version: 0.1.0
config:
  runtime: 4
`;

const withTempRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-tarball-recipe-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

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

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const expectKind = async (promise: Promise<unknown>, kind: RecipeSourceError["kind"]) => {
  try {
    await promise;
    throw new Error(`expected ${kind}`);
  } catch (cause) {
    expect(cause).toBeInstanceOf(RecipeSourceError);
    if (!(cause instanceof RecipeSourceError)) throw cause;
    expect(cause.kind).toBe(kind);
  }
};

describe("resolveTarballRecipeSource", () => {
  test("acquires through the session and resolves recipe.yml", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const calls: string[] = [];
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          archive: makeArchiveTransportForBytes(bytes, calls),
        },
        async ({ session }) => {
          const result = await resolveTarballRecipeSource({
            url: "https://example.test/recipe.tgz",
            sources: session,
            checksum: sha256(bytes),
          });
          expect(calls).toEqual(["https://example.test/recipe.tgz"]);
          expect(result.sha256).toBe(sha256(bytes));
          expect(result.manifestYaml).toContain("id: remote-recipe");
          expect(result.transport).toEqual({ kind: "archive", digest: sha256(bytes) });
        },
      );
    });
  });

  test("checksum hit reuses the cache without re-fetching", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const digest = sha256(bytes);
      const storeRoot = join(dir, "sources");
      const { makeRecipeTestStateStore } = await import("../_support/recipe-source-session.ts");
      const stateStore = makeRecipeTestStateStore();
      const calls: string[] = [];
      await withRecipeSources(
        {
          root: storeRoot,
          stateStore,
          archive: makeArchiveTransportForBytes(bytes, calls),
        },
        async ({ session }) => {
          await resolveTarballRecipeSource({
            url: "https://example.test/recipe.tgz",
            sources: session,
            checksum: digest,
          });
        },
      );
      expect(calls).toHaveLength(1);
      await withRecipeSources(
        {
          root: storeRoot,
          stateStore,
          archive: {
            fetch: async () => {
              throw new Error("network should not be used");
            },
          },
        },
        async ({ session }) => {
          const result = await resolveTarballRecipeSource({
            url: "https://example.test/recipe.tgz",
            sources: session,
            checksum: digest,
          });
          expect(result.sha256).toBe(digest);
        },
      );
    });
  });

  test("checksum mismatch fails before extract", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          archive: makeArchiveTransportForBytes(bytes),
        },
        async ({ session }) => {
          await expectKind(
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tgz",
              sources: session,
              checksum: "0".repeat(64),
            }),
            "checksum-mismatch",
          );
        },
      );
    });
  });

  test("unverified decline aborts with checksum-unverified", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          archive: makeArchiveTransportForBytes(bytes),
        },
        async ({ session }) => {
          await expectKind(
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tgz",
              sources: session,
              confirmUnverified: async () => false,
            }),
            "checksum-unverified",
          );
        },
      );
    });
  });

  test("rejects path traversal in --path", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          archive: makeArchiveTransportForBytes(bytes),
        },
        async ({ session }) => {
          await expectKind(
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tgz",
              sources: session,
              path: "../escape",
              checksum: sha256(bytes),
            }),
            "subpath-invalid",
          );
        },
      );
    });
  });
});
