import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RecipeSourceError } from "@lando/sdk/errors";

import { resolveNpmRecipeSource } from "../../src/recipes/npm-source.ts";
import { makeNpmRegistryTransport, withRecipeSources } from "../_support/recipe-source-session.ts";

const VALID_RECIPE = `id: npm-recipe
title: Npm Recipe
description: An npm sourced recipe.
version: 0.1.0
config:
  runtime: 4
`;

const withTempRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-npm-recipe-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const makeNpmTarball = async (files: Readonly<Record<string, string>>): Promise<Uint8Array> => {
  const stage = await realpath(await mkdtemp(join(tmpdir(), "lando-npm-build-")));
  const pkg = join(stage, "package");
  const out = join(stage, "archive.tgz");
  try {
    await mkdir(pkg, { recursive: true });
    for (const [rel, fileContent] of Object.entries(files)) {
      const target = join(pkg, rel);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, fileContent);
    }
    const proc = Bun.spawn({
      cmd: ["tar", "-czf", out, "-C", stage, "package"],
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

const sha512Sri = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const TARBALL_URL = "https://registry.npmjs.org/@lando/recipe-foo/-/recipe-foo-1.2.3.tgz";

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

describe("resolveNpmRecipeSource", () => {
  test("acquires via session and resolves package/recipe.yml", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          npmRegistry: makeNpmRegistryTransport({
            tarball: bytes,
            packument: {
              "dist-tags": { latest: "1.2.3" },
              versions: {
                "1.2.3": {
                  dist: { tarball: TARBALL_URL, integrity: sha512Sri(bytes) },
                },
              },
            },
          }),
        },
        async ({ session }) => {
          const result = await resolveNpmRecipeSource({
            package: "@lando/recipe-foo",
            sources: session,
          });
          expect(result.packageName).toBe("@lando/recipe-foo");
          expect(result.version).toBe("1.2.3");
          expect(result.manifestYaml).toContain("id: npm-recipe");
          expect(result.transport?.kind).toBe("archive");
        },
      );
    });
  });

  test("fails when integrity is missing", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          npmRegistry: makeNpmRegistryTransport({
            tarball: bytes,
            packument: {
              "dist-tags": { latest: "1.0.0" },
              versions: {
                "1.0.0": { dist: { tarball: TARBALL_URL } },
              },
            },
          }),
        },
        async ({ session }) => {
          await expectKind(
            resolveNpmRecipeSource({
              package: "@lando/recipe-foo@1.0.0",
              sources: session,
            }),
            "integrity-missing",
          );
        },
      );
    });
  });

  test("fails on integrity mismatch", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      await withRecipeSources(
        {
          root: join(dir, "sources"),
          npmRegistry: makeNpmRegistryTransport({
            tarball: bytes,
            packument: {
              versions: {
                "1.0.0": {
                  dist: {
                    tarball: TARBALL_URL,
                    integrity:
                      "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
                  },
                },
              },
            },
          }),
        },
        async ({ session }) => {
          await expectKind(
            resolveNpmRecipeSource({
              package: "@lando/recipe-foo@1.0.0",
              sources: session,
            }),
            "integrity-mismatch",
          );
        },
      );
    });
  });
});
