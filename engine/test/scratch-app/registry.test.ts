import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { makeLandoPaths } from "@lando/paths";

import { type ScratchRegistryEntry, makeScratchRegistry } from "../../src/scratch-app/registry.ts";
import { detachScratchApp } from "../../src/scratch-app/service.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const withTempRoots = async <T>(
  run: (roots: { readonly dataRoot: string; readonly cacheRoot: string }) => Promise<T>,
): Promise<T> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-registry-")));
  const dataRoot = join(base, "data");
  const cacheRoot = join(base, "cache");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousCache = process.env.LANDO_USER_CACHE_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    return await run({ dataRoot, cacheRoot });
  } finally {
    if (previousData === undefined) {
      Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    } else {
      process.env.LANDO_USER_DATA_ROOT = previousData;
    }
    if (previousCache === undefined) {
      Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    } else {
      process.env.LANDO_USER_CACHE_ROOT = previousCache;
    }
    await rm(base, { recursive: true, force: true });
  }
};

const entry = (id: string): ScratchRegistryEntry => ({
  id,
  source: { kind: "fork" },
  isolate: "full",
  detached: true,
  rootPath: join(makeLandoPaths().scratchDir, id, "root"),
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const registryFile = (): string => join(makeLandoPaths().scratchDir, "registry.bin");

describe("scratch registry", () => {
  test("detach stamps the advanced execution clock while preserving creation time", async () => {
    await withTempRoots(async () => {
      // Given an attached entry and an execution clock independent of host time.
      const registry = makeScratchRegistry(ownerOnlyFileAccess);
      const original = { ...entry("scratch-clock-000001"), detached: false, ownerPid: process.pid };
      await Effect.runPromise(registry.upsert(original));
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(0);
          yield* TestClock.adjust("1234 millis");

          // When lifecycle ownership is detached after virtual time advances.
          yield* detachScratchApp(original.id, ownerOnlyFileAccess);

          // Then only the update timestamp follows the execution clock.
          const detached = yield* registry.get(original.id);
          expect(detached?.updatedAt).toBe("1970-01-01T00:00:01.234Z");
          expect(detached?.createdAt).toBe(original.createdAt);
          expect(detached?.detached).toBe(true);
          expect(detached?.ownerPid).toBeUndefined();
        }).pipe(Effect.provide(TestClock.layer())),
      );
    });
  });

  test("upsert, list, and get roundtrip through registry.bin", async () => {
    await withTempRoots(async () => {
      const registry = makeScratchRegistry(ownerOnlyFileAccess);
      const first = entry("scratch-one-000001");
      const second = entry("scratch-two-000002");

      await Effect.runPromise(registry.upsert(second));
      await Effect.runPromise(registry.upsert(first));

      await expect(Effect.runPromise(registry.list())).resolves.toEqual([first, second]);
      await expect(Effect.runPromise(registry.get(first.id))).resolves.toEqual(first);
      await expect(Effect.runPromise(registry.get("scratch-missing-ffffff"))).resolves.toBeUndefined();
      expect(await readFile(registryFile(), "utf8")).toContain(first.id);
    });
  });

  test("corrupt registry files are quarantined and rebuilt empty", async () => {
    await withTempRoots(async () => {
      const base = makeLandoPaths().scratchDir;
      await mkdir(base, { recursive: true });
      await writeFile(registryFile(), "not-json");

      await expect(Effect.runPromise(makeScratchRegistry(ownerOnlyFileAccess).list())).resolves.toEqual([]);

      const files = await readdir(base);
      expect(files.some((file) => file.startsWith("registry.bin.corrupt-"))).toBe(true);
    });
  });

  test("registry entry and instance contents survive removal of a distinct user cache root", async () => {
    await withTempRoots(async ({ dataRoot, cacheRoot }) => {
      // Given a registered scratch with instance files under user data and noise under cache.
      const registry = makeScratchRegistry(ownerOnlyFileAccess);
      const id = "scratch-keep-000001";
      const registered = entry(id);
      const instanceRoot = registered.rootPath;
      const marker = join(instanceRoot, "keep.txt");
      await mkdir(instanceRoot, { recursive: true });
      await writeFile(marker, "durable-instance");
      await mkdir(join(cacheRoot, "logs"), { recursive: true });
      await writeFile(join(cacheRoot, "logs", "noise.log"), "disposable");
      await Effect.runPromise(registry.upsert(registered));

      // When the disposable user cache root is removed entirely.
      await rm(cacheRoot, { recursive: true, force: true });

      // Then the registry entry and instance tree remain under user data.
      await expect(Effect.runPromise(registry.list())).resolves.toEqual([registered]);
      expect(await readFile(marker, "utf8")).toBe("durable-instance");
      expect(await Bun.file(join(dataRoot, "scratch", "registry.bin")).exists()).toBe(true);
    });
  });
});
