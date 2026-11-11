import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { ScratchAppError } from "@lando/sdk/errors";
import { StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { type ScratchRegistryEntry, makeScratchRegistry } from "../../src/scratch-app/registry.ts";
import { detachScratchApp } from "../../src/scratch-app/service.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const testStore = () => makeStateStore({ privateFileAccess: ownerOnlyFileAccess });
const testRegistry = () => makeScratchRegistry(testStore());

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
  test.each(["acquiring", "running"] as const)("detach owns detached while %s", async (status) => {
    await withTempRoots(async () => {
      const registry = testRegistry();
      const original = { ...entry("scratch-detach"), detached: false };
      await Effect.runPromise(registry.upsert("acquire", original));
      if (status === "running") await Effect.runPromise(registry.upsert("mark-running", original));

      await Effect.runPromise(registry.upsert("detach", original));

      expect(await Effect.runPromise(registry.get(original.id))).toMatchObject({ detached: true, status });
    });
  });

  test.each([false, true])(
    "writes preserve the stored detached=%s despite stale caller data",
    async (detached) => {
      await withTempRoots(async () => {
        const registry = testRegistry();
        const original = { ...entry("scratch-preserve"), detached };
        await Effect.runPromise(registry.upsert("acquire", original));
        const stale = { ...original, detached: !detached };

        await Effect.runPromise(registry.upsert("mark-running", stale));
        expect(await Effect.runPromise(registry.get(original.id))).toMatchObject({
          detached,
          status: "running",
        });
        await Effect.runPromise(registry.upsert("mark-pending-cleanup", stale));
        expect(await Effect.runPromise(registry.get(original.id))).toMatchObject({
          detached,
          status: "destroyed-pending-cleanup",
        });
      });
    },
  );

  test("mark-running cannot reattach an entry detached during acquisition", async () => {
    await withTempRoots(async () => {
      const registry = testRegistry();
      const original = { ...entry("scratch-race"), detached: false };
      await Effect.runPromise(registry.upsert("acquire", original));
      await Effect.runPromise(registry.upsert("detach", original));

      await Effect.runPromise(registry.upsert("mark-running", original));

      expect(await Effect.runPromise(registry.get(original.id))).toMatchObject({
        detached: true,
        status: "running",
      });
    });
  });

  test("rejects restarting an entry pending cleanup without changing the registry", async () => {
    await withTempRoots(async () => {
      const registry = testRegistry();
      const original = entry("scratch-cleanup-000001");
      await Effect.runPromise(registry.upsert("acquire", original));
      const pending = { ...original, status: "destroyed-pending-cleanup" as const };
      await Effect.runPromise(registry.upsert("mark-pending-cleanup", original));

      const result = await Effect.runPromise(registry.upsert("mark-running", original).pipe(Effect.result));

      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("Expected a rejected transition");
      expect(result.failure).toBeInstanceOf(ScratchAppError);
      expect(result.failure.operation).toBe("registry.write");
      expect(result.failure.message).toContain("cannot mark-running while destroyed-pending-cleanup");
      expect(result.failure.remediation).toContain("lando apps:scratch:gc");
      await expect(Effect.runPromise(registry.list())).resolves.toEqual([pending]);
    });
  });

  test("settled and refused steps leave the stored registry bytes untouched", async () => {
    await withTempRoots(async () => {
      // Given a stored registry whose bytes differ from what a rewrite would emit.
      const registry = testRegistry();
      const pending = entry("scratch-settled-000001");
      await Effect.runPromise(registry.upsert("acquire", pending));
      await Effect.runPromise(registry.upsert("mark-pending-cleanup", pending));
      const stored = JSON.stringify(JSON.parse(await readFile(registryFile(), "utf8")));
      await writeFile(registryFile(), stored);

      // When removing an absent entry (settled) and restarting a pending one (refused).
      await Effect.runPromise(registry.remove("scratch-absent-000002"));
      const refused = await Effect.runPromise(Effect.result(registry.upsert("mark-running", pending)));

      // Then neither step rewrote the file.
      expect(refused._tag).toBe("Failure");
      expect(await readFile(registryFile(), "utf8")).toBe(stored);
    });
  });

  test("migrates v1 stopping entries without losing other entries or quarantining the registry", async () => {
    await withTempRoots(async () => {
      const stopping = { ...entry("scratch-stopping-000001"), status: "stopping" };
      const running = entry("scratch-running-000002");
      const acquiring = { ...entry("scratch-acquiring-000003"), status: "acquiring" as const };
      await mkdir(makeLandoPaths().scratchDir, { recursive: true });
      await writeFile(registryFile(), JSON.stringify({ version: 1, data: [stopping, running, acquiring] }));

      const registry = testRegistry();
      const migrated = await Effect.runPromise(registry.list());

      const pending = { ...stopping, status: "destroyed-pending-cleanup" as const };
      expect(migrated).toEqual([pending, running, acquiring]);
      expect(await readdir(makeLandoPaths().scratchDir)).toEqual(["registry.bin"]);
      await Effect.runPromise(registry.upsert("mark-pending-cleanup", pending));
      expect(JSON.parse(await readFile(registryFile(), "utf8"))).toEqual({
        version: 2,
        data: [acquiring, running, pending],
      });
    });
  });

  test("detach stamps the advanced execution clock while preserving creation time", async () => {
    await withTempRoots(async () => {
      // Given an attached entry and an execution clock independent of host time.
      const store = testStore();
      const registry = makeScratchRegistry(store);
      const original = { ...entry("scratch-clock-000001"), detached: false, ownerPid: process.pid };
      await Effect.runPromise(registry.upsert("acquire", original));
      await Effect.runPromise(registry.upsert("mark-running", original));
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(0);
          yield* TestClock.adjust("1234 millis");

          // When lifecycle ownership is detached after virtual time advances.
          yield* detachScratchApp(original.id);

          // Then only the update timestamp follows the execution clock.
          const detached = yield* registry.get(original.id);
          expect(detached?.updatedAt).toBe("1970-01-01T00:00:01.234Z");
          expect(detached?.createdAt).toBe(original.createdAt);
          expect(detached?.detached).toBe(true);
          expect(detached?.ownerPid).toBeUndefined();
        }).pipe(Effect.provide(TestClock.layer()), Effect.provideService(StateStore, store)),
      );
    });
  });

  test("upsert, list, and get roundtrip through registry.bin", async () => {
    await withTempRoots(async () => {
      const registry = testRegistry();
      const first = entry("scratch-one-000001");
      const second = entry("scratch-two-000002");

      await Effect.runPromise(registry.upsert("acquire", second));
      await Effect.runPromise(registry.upsert("mark-running", second));
      await Effect.runPromise(registry.upsert("acquire", first));
      await Effect.runPromise(registry.upsert("mark-running", first));

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

      await expect(Effect.runPromise(testRegistry().list())).resolves.toEqual([]);

      const files = await readdir(base);
      expect(files.some((file) => file.startsWith("registry.bin.corrupt-"))).toBe(true);
    });
  });

  test("registry entry and instance contents survive removal of a distinct user cache root", async () => {
    await withTempRoots(async ({ dataRoot, cacheRoot }) => {
      // Given a registered scratch with instance files under user data and noise under cache.
      const registry = testRegistry();
      const id = "scratch-keep-000001";
      const registered = entry(id);
      const instanceRoot = registered.rootPath;
      const marker = join(instanceRoot, "keep.txt");
      await mkdir(instanceRoot, { recursive: true });
      await writeFile(marker, "durable-instance");
      await mkdir(join(cacheRoot, "logs"), { recursive: true });
      await writeFile(join(cacheRoot, "logs", "noise.log"), "disposable");
      await Effect.runPromise(registry.upsert("acquire", registered));
      await Effect.runPromise(registry.upsert("mark-running", registered));

      // When the disposable user cache root is removed entirely.
      await rm(cacheRoot, { recursive: true, force: true });

      // Then the registry entry and instance tree remain under user data.
      await expect(Effect.runPromise(registry.list())).resolves.toEqual([registered]);
      expect(await readFile(marker, "utf8")).toBe("durable-instance");
      expect(await Bun.file(join(dataRoot, "scratch", "registry.bin")).exists()).toBe(true);
    });
  });
});
