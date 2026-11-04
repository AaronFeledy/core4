import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RecipeSourceError } from "@lando/sdk/errors";

import { type RecipeRegistryClient, resolveRegistryRecipeSource } from "../../src/recipes/registry-source.ts";
import {
  makeArchiveTransportForBytes,
  makeGitRecipeTransport,
  withRecipeSources,
} from "../_support/recipe-source-session.ts";

const VALID_RECIPE = `id: registry-recipe
title: Registry Recipe
description: From registry.
version: 0.1.0
config:
  runtime: 4
`;

const withTempRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-registry-recipe-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const makeTarball = async (files: Readonly<Record<string, string>>): Promise<Uint8Array> => {
  const stage = await realpath(await mkdtemp(join(tmpdir(), "lando-reg-tar-")));
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

describe("resolveRegistryRecipeSource", () => {
  test("delegates git resolutions through the source session", async () => {
    await withTempRoot(async (dir) => {
      const client: RecipeRegistryClient = {
        fetchResolution: async () => ({
          id: "demo",
          resolution: { kind: "git", url: "https://example.test/recipes.git" },
        }),
      };
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          git: makeGitRecipeTransport({ commitSha: "b".repeat(40), manifest: VALID_RECIPE }),
        },
        async ({ session }) => {
          const result = await resolveRegistryRecipeSource({
            id: "demo",
            sources: session,
            registryClient: client,
          });
          expect(result.id).toBe("demo");
          expect(result.manifestYaml).toContain("id: registry-recipe");
        },
      );
    });
  });

  test("delegates tarball resolutions through the source session", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const digest = sha256(bytes);
      const client: RecipeRegistryClient = {
        fetchResolution: async () => ({
          id: "demo",
          resolution: {
            kind: "tarball",
            url: "https://example.test/recipe.tgz",
            checksum: digest,
          },
        }),
      };
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          archive: makeArchiveTransportForBytes(bytes),
        },
        async ({ session }) => {
          const result = await resolveRegistryRecipeSource({
            id: "demo",
            sources: session,
            registryClient: client,
          });
          expect(result.id).toBe("demo");
          expect(result.sha256).toBe(digest);
        },
      );
    });
  });

  test("missing id fails", async () => {
    await withTempRoot(async (dir) => {
      await withRecipeSources({ root: join(dir, "sources") }, async ({ session }) => {
        await expect(resolveRegistryRecipeSource({ id: " ", sources: session })).rejects.toBeInstanceOf(
          RecipeSourceError,
        );
      });
    });
  });

  test("recipe-not-found when registry returns undefined", async () => {
    await withTempRoot(async (dir) => {
      await withRecipeSources({ root: join(dir, "sources") }, async ({ session }) => {
        try {
          await resolveRegistryRecipeSource({
            id: "missing",
            sources: session,
            registryClient: { fetchResolution: async () => undefined },
          });
          throw new Error("expected failure");
        } catch (cause) {
          expect(cause).toBeInstanceOf(RecipeSourceError);
          if (!(cause instanceof RecipeSourceError)) throw cause;
          expect(cause.kind).toBe("recipe-not-found");
        }
      });
    });
  });
});
