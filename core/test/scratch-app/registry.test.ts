import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import {
  type ScratchRegistryEntry,
  acquireScratchRegistryLock,
  makeScratchRegistry,
  scratchRegistryPaths,
} from "../../src/scratch-app/registry.ts";
import { LOCK_STALE_THRESHOLD_MS } from "../../src/state/lock.ts";

const withTempCache = async <T>(run: (cacheRoot: string) => Promise<T>): Promise<T> => {
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-registry-cache-")));
  const previous = process.env.LANDO_USER_CACHE_ROOT;
  try {
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    return await run(cacheRoot);
  } finally {
    if (previous === undefined) {
      // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
      delete process.env.LANDO_USER_CACHE_ROOT;
    } else {
      process.env.LANDO_USER_CACHE_ROOT = previous;
    }
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const entry = (id: string): ScratchRegistryEntry => ({
  id,
  source: { kind: "fork" },
  isolate: "full",
  detached: true,
  rootPath: join(process.env.LANDO_USER_CACHE_ROOT ?? "", "scratch", id, "root"),
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("scratch registry", () => {
  test("upsert, list, and get roundtrip through registry.bin", async () => {
    await withTempCache(async () => {
      const registry = makeScratchRegistry();
      const first = entry("scratch-one-000001");
      const second = entry("scratch-two-000002");

      await Effect.runPromise(registry.upsert(second));
      await Effect.runPromise(registry.upsert(first));

      await expect(Effect.runPromise(registry.list())).resolves.toEqual([first, second]);
      await expect(Effect.runPromise(registry.get(first.id))).resolves.toEqual(first);
      await expect(Effect.runPromise(registry.get("scratch-missing-ffffff"))).resolves.toBeUndefined();
      expect(await readFile(scratchRegistryPaths().registry, "utf8")).toContain(first.id);
    });
  });

  test("corrupt registry files are quarantined and rebuilt empty", async () => {
    await withTempCache(async () => {
      const paths = scratchRegistryPaths();
      await mkdir(paths.base, { recursive: true });
      await writeFile(paths.registry, "not-json");

      await expect(Effect.runPromise(makeScratchRegistry().list())).resolves.toEqual([]);

      const files = await readdir(paths.base);
      expect(files.some((file) => file.startsWith("registry.bin.corrupt-"))).toBe(true);
    });
  });

  test("legacy migration uses the same registry path as the StateStore bucket under a symlinked cache root", async () => {
    const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-registry-real-")));
    const linkRoot = join(tmpdir(), `lando-scratch-registry-link-${Date.now()}`);
    await symlink(cacheRoot, linkRoot);

    const previous = process.env.LANDO_USER_CACHE_ROOT;
    try {
      process.env.LANDO_USER_CACHE_ROOT = linkRoot;
      const paths = scratchRegistryPaths();
      const first = entry("scratch-one-000001");
      await mkdir(join(cacheRoot, "scratch"), { recursive: true });
      await writeFile(
        join(cacheRoot, "scratch", "registry.bin"),
        `${JSON.stringify({ version: 1, entries: [first] })}\n`,
      );

      await expect(Effect.runPromise(makeScratchRegistry().list())).resolves.toEqual([first]);

      const raw = JSON.parse(await readFile(paths.registry, "utf8")) as unknown;
      expect(raw).toEqual({ version: 1, data: [first] });
    } finally {
      if (previous === undefined) {
        // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
        delete process.env.LANDO_USER_CACHE_ROOT;
      } else {
        process.env.LANDO_USER_CACHE_ROOT = previous;
      }
      await rm(linkRoot, { force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test("legacy registry envelopes are migrated into the StateStore frame", async () => {
    await withTempCache(async () => {
      const paths = scratchRegistryPaths();
      const first = entry("scratch-one-000001");
      const second = { ...entry("scratch-two-000002"), source: { kind: "recipe" as const, ref: "empty" } };
      const legacyFirst = { ...first, isolate: "none" };
      const legacySecond = { ...second, isolate: "none" };
      await mkdir(paths.base, { recursive: true });
      await writeFile(
        paths.registry,
        `${JSON.stringify({ version: 1, entries: [legacyFirst, legacySecond] })}\n`,
      );

      await expect(Effect.runPromise(makeScratchRegistry().list())).resolves.toEqual([
        { ...first, isolate: "cwd" },
        { ...second, isolate: "baked" },
      ]);

      const raw = JSON.parse(await readFile(paths.registry, "utf8")) as unknown;
      expect(raw).toEqual({
        version: 1,
        data: [
          { ...first, isolate: "cwd" },
          { ...second, isolate: "baked" },
        ],
      });
      const files = await readdir(paths.base);
      expect(files.some((file) => file.startsWith("registry.bin.corrupt-"))).toBe(false);
    });
  });

  test("StateStore-framed legacy none isolation is normalized before bucket open", async () => {
    await withTempCache(async () => {
      const paths = scratchRegistryPaths();
      const fork = entry("scratch-fork-000001");
      const recipe = { ...entry("scratch-recipe-000002"), source: { kind: "recipe" as const, ref: "empty" } };
      await mkdir(paths.base, { recursive: true });
      await writeFile(
        paths.registry,
        `${JSON.stringify({
          version: 1,
          data: [
            { ...fork, isolate: "none" },
            { ...recipe, isolate: "none" },
          ],
        })}\n`,
      );

      await expect(Effect.runPromise(makeScratchRegistry().list())).resolves.toEqual([
        { ...fork, isolate: "cwd" },
        { ...recipe, isolate: "baked" },
      ]);

      const raw = JSON.parse(await readFile(paths.registry, "utf8")) as unknown;
      expect(raw).toEqual({
        version: 1,
        data: [
          { ...fork, isolate: "cwd" },
          { ...recipe, isolate: "baked" },
        ],
      });
    });
  });

  test("StateStore-framed current isolation is not rewritten by legacy migration", async () => {
    await withTempCache(async () => {
      const paths = scratchRegistryPaths();
      const first = entry("scratch-one-000001");
      await mkdir(paths.base, { recursive: true });
      const currentFrame = `${JSON.stringify({ version: 1, data: [first] }, null, 2)}\n`;
      await writeFile(paths.registry, currentFrame);

      await expect(Effect.runPromise(makeScratchRegistry().list())).resolves.toEqual([first]);

      expect(await readFile(paths.registry, "utf8")).toBe(currentFrame);
    });
  });

  test("lock release removes only the matching token", async () => {
    await withTempCache(async () => {
      const paths = scratchRegistryPaths();
      const lock = await Effect.runPromise(acquireScratchRegistryLock(paths));
      await writeFile(
        paths.lock,
        JSON.stringify({ pid: process.pid, token: "other", createdAt: Date.now() }),
      );

      await Effect.runPromise(lock.release);

      const current = JSON.parse(await readFile(paths.lock, "utf8")) as { readonly token: string };
      expect(current.token).toBe("other");
    });
  });

  test("stale legacy locks are taken over", async () => {
    await withTempCache(async () => {
      const paths = scratchRegistryPaths();
      await mkdir(paths.base, { recursive: true });
      await writeFile(
        paths.lock,
        JSON.stringify({
          pid: process.pid,
          token: "stale",
          createdAt: Date.now() - LOCK_STALE_THRESHOLD_MS - 1_000,
        }),
      );

      const lock = await Effect.runPromise(acquireScratchRegistryLock(paths));

      const current = JSON.parse(await readFile(paths.lock, "utf8")) as { readonly token: string };
      expect(current.token).toBe(lock.token);
      await Effect.runPromise(lock.release);
      expect(await Bun.file(paths.lock).exists()).toBe(false);
    });
  });
});
