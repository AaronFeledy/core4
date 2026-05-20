import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Option, Schema, TestClock, TestContext } from "effect";

import { CacheError } from "@lando/core/errors";
import { CacheService } from "@lando/core/services";
import {
  CWD_APP_MAP_CACHE_FILE,
  deleteCwdAppMapEntry,
  listCwdAppMapEntries,
  readCwdAppMapEntry,
  writeCwdAppMapEntry,
} from "../../src/cache/cwd-app-map.ts";
import { CacheServiceLive } from "../../src/cache/service.ts";

const CachedValue = Schema.Struct({
  name: Schema.String,
  count: Schema.Number,
});

const runWithCache = <A>(effect: Effect.Effect<A, CacheError, CacheService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(CacheServiceLive)));

describe("CacheServiceLive", () => {
  test("round-trips cached values through schema decode", async () => {
    const value = await runWithCache(
      Effect.flatMap(CacheService, (cache) =>
        Effect.gen(function* () {
          yield* cache.write("plans:app", { name: "app", count: 1 });
          return yield* cache.read("plans:app", CachedValue);
        }),
      ),
    );

    expect(value).toEqual({ name: "app", count: 1 });
  });

  test("keeps distinct keys isolated", async () => {
    const values = await runWithCache(
      Effect.flatMap(CacheService, (cache) =>
        Effect.gen(function* () {
          yield* cache.write("apps:first", { name: "first", count: 1 });
          yield* cache.write("apps:second", { name: "second", count: 2 });
          const first = yield* cache.read("apps:first", CachedValue);
          const second = yield* cache.read("apps:second", CachedValue);
          return { first, second };
        }),
      ),
    );

    expect(values).toEqual({
      first: { name: "first", count: 1 },
      second: { name: "second", count: 2 },
    });
  });

  test("returns null for missing and expired keys", async () => {
    const values = await Effect.runPromise(
      Effect.flatMap(CacheService, (cache) =>
        Effect.gen(function* () {
          const missing = yield* cache.read("missing", CachedValue);
          yield* cache.write("short-lived", { name: "stale", count: 1 }, 1);
          yield* TestClock.adjust("5 millis");
          const expired = yield* cache.read("short-lived", CachedValue);
          return { expired, missing };
        }),
      ).pipe(Effect.provide(CacheServiceLive), Effect.provide(TestContext.TestContext)),
    );

    expect(values).toEqual({ expired: null, missing: null });
  });

  test("fails loudly when stored data no longer matches the requested schema", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(CacheService, (cache) =>
        Effect.gen(function* () {
          yield* cache.write("bad", { name: "bad", count: "not-a-number" });
          return yield* cache.read("bad", CachedValue);
        }),
      ).pipe(Effect.provide(CacheServiceLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(CacheError);
        expect(failure.value).toMatchObject({
          _tag: "CacheError",
          key: "bad",
        });
        expect(failure.value.decodeError).toBeDefined();
      }
    }
  });

  test("writes, reads, lists, and deletes persistent cwd-app-map entries", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-cwd-app-map-"));
    const entry = {
      cwd: "/workspace/app/subdir",
      appRoot: "/workspace/app",
      primaryLandofilePath: "/workspace/app/.lando.yml",
      mtimeNs: 10,
      sizeBytes: 20,
      lastUsedAt: 30,
    };

    await Effect.runPromise(writeCwdAppMapEntry({ cacheRoot, entry }));
    await Effect.runPromise(
      writeCwdAppMapEntry({
        cacheRoot,
        maxEntries: 2,
        entry: {
          cwd: "/workspace/other",
          appRoot: "/workspace/other",
          primaryLandofilePath: "/workspace/other/.lando.yml",
          mtimeNs: 11,
          sizeBytes: 21,
          lastUsedAt: 40,
        },
      }),
    );

    const read = await Effect.runPromise(readCwdAppMapEntry({ cacheRoot, cwd: entry.cwd }));
    const listed = await Effect.runPromise(listCwdAppMapEntries(cacheRoot));
    await Effect.runPromise(deleteCwdAppMapEntry({ cacheRoot, cwd: entry.cwd }));
    const afterDelete = await Effect.runPromise(readCwdAppMapEntry({ cacheRoot, cwd: entry.cwd }));

    expect(read).toEqual(entry);
    expect(listed.map((item) => item.cwd).sort()).toEqual(["/workspace/app/subdir", "/workspace/other"]);
    expect(afterDelete).toBeNull();
  });

  test("upserts a cwd entry so the newest metadata wins over a stale duplicate", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-cwd-app-map-upsert-"));
    const cwd = "/workspace/dup";
    await Effect.runPromise(
      writeCwdAppMapEntry({
        cacheRoot,
        entry: {
          cwd,
          appRoot: "/workspace/stale",
          primaryLandofilePath: "/workspace/stale/.lando.yml",
          mtimeNs: 1,
          sizeBytes: 1,
          lastUsedAt: 10,
        },
      }),
    );
    await Effect.runPromise(
      writeCwdAppMapEntry({
        cacheRoot,
        entry: {
          cwd,
          appRoot: "/workspace/fresh",
          primaryLandofilePath: "/workspace/fresh/.lando.yml",
          mtimeNs: 2,
          sizeBytes: 2,
          lastUsedAt: 20,
        },
      }),
    );

    const read = await Effect.runPromise(readCwdAppMapEntry({ cacheRoot, cwd }));
    const listed = await Effect.runPromise(listCwdAppMapEntries(cacheRoot));

    expect(read?.appRoot).toBe("/workspace/fresh");
    expect(read?.lastUsedAt).toBe(20);
    expect(listed.length).toBe(1);
  });

  test("silently invalidates a cwd-app-map cache whose landoVersion does not match", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-cwd-app-map-version-"));
    await Effect.runPromise(
      writeCwdAppMapEntry({
        cacheRoot,
        entry: {
          cwd: "/v1/cwd",
          appRoot: "/v1/app",
          primaryLandofilePath: "/v1/app/.lando.yml",
          mtimeNs: 1,
          sizeBytes: 1,
          lastUsedAt: 1,
        },
      }),
    );
    const cacheFile = join(cacheRoot, CWD_APP_MAP_CACHE_FILE);
    const original = Buffer.from(await Bun.file(cacheFile).arrayBuffer());
    const header = original.subarray(0, 44);
    const payload = original.subarray(44);
    const decoded = (await import("node:v8")).deserialize(payload) as {
      landoVersion: string;
      entries: unknown[];
    };
    const rewritten = (await import("node:v8")).serialize({ ...decoded, landoVersion: "0.0.0-bogus" });
    const newHeader = Buffer.from(header);
    (await import("node:crypto")).createHash("sha256").update(rewritten).digest().copy(newHeader, 12);
    await writeFile(cacheFile, Buffer.concat([newHeader, rewritten]));

    const listed = await Effect.runPromise(listCwdAppMapEntries(cacheRoot));
    expect(listed).toEqual([]);
  });

  test("fails corrupt cwd-app-map reads with a remediation message", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-cwd-app-map-corrupt-"));
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(join(cacheRoot, CWD_APP_MAP_CACHE_FILE), "not a valid binary cache");

    const exit = await Effect.runPromiseExit(listCwdAppMapEntries(cacheRoot));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(CacheError);
        expect(failure.value.message).toContain("run `lando app:cache:refresh`");
      }
    }
  });
});
