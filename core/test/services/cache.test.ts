import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, DateTime, Effect, Exit, Option, Schema, TestClock, TestContext } from "effect";

import { CacheError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PluginName,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
} from "@lando/core/schema";
import { CacheService } from "@lando/core/services";
import { deriveAppPlanCacheKey, readCachedAppPlan, writeCachedAppPlan } from "../../src/cache/app-plan.ts";
import { writeFileAtomicViaRename } from "../../src/cache/atomic.ts";
import {
  CWD_APP_MAP_CACHE_FILE,
  deleteCwdAppMapEntry,
  listCwdAppMapEntries,
  readCwdAppMapEntry,
  writeCwdAppMapEntry,
} from "../../src/cache/cwd-app-map.ts";
import { appPlanCachePath } from "../../src/cache/paths.ts";
import { CacheServiceLive } from "../../src/cache/service.ts";

const CachedValue = Schema.Struct({
  name: Schema.String,
  count: Schema.Number,
});

const runWithCache = <A>(effect: Effect.Effect<A, CacheError, CacheService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(CacheServiceLive)));

const appPlanFixture: AppPlan = {
  id: AppId.make("cache-plan"),
  name: "cache-plan",
  slug: "cache-plan",
  root: AbsolutePath.make("/workspace/cache-plan"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-05-20T00:00:00Z"),
    source: "/workspace/cache-plan/.lando.yml",
    runtime: 4,
  },
  extensions: {},
};

const providerCapabilities: ProviderCapabilities = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "native",
  hostReachability: "native",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "native",
  routeProvider: true,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "native",
  providerExtensions: ["compose"],
};

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

  test("derives app-plan cache keys from Landofile, plugin, and provider inputs", () => {
    const base = {
      landofile: { name: "cache-plan", services: { [ServiceName.make("web")]: { type: "node" } } },
      providerCapabilities,
      pluginManifests: [
        {
          name: PluginName.make("@lando/node"),
          version: "1.0.0",
          api: 4 as const,
          contributes: { serviceTypes: ["node"] },
        },
      ],
    };

    const key = deriveAppPlanCacheKey(base);

    expect(deriveAppPlanCacheKey(base)).toBe(key);
    expect(
      deriveAppPlanCacheKey({
        ...base,
        landofile: {
          name: "cache-plan",
          services: { [ServiceName.make("web")]: { type: "node", environment: { NODE_ENV: "test" } } },
        },
      }),
    ).not.toBe(key);
    expect(
      deriveAppPlanCacheKey({
        ...base,
        pluginManifests: [
          {
            name: PluginName.make("@lando/node"),
            version: "1.0.1",
            api: 4 as const,
            contributes: { serviceTypes: ["node"] },
          },
        ],
      }),
    ).not.toBe(key);
    expect(
      deriveAppPlanCacheKey({
        ...base,
        providerCapabilities: { ...providerCapabilities, bindMounts: false },
      }),
    ).not.toBe(key);
  });

  test("writes and reads app-plan caches through CacheService.writeAtomic", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-cache-"));
    const key = "app-plan-key";

    const cachePath = await runWithCache(
      writeCachedAppPlan({ cacheRoot, appName: "cache-plan", key, plan: appPlanFixture, now: () => 1 }),
    );
    const read = await Effect.runPromise(readCachedAppPlan({ cacheRoot, appName: "cache-plan", key }));
    const stale = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "cache-plan", key: "different" }),
    );

    expect(cachePath).toBe(appPlanCachePath(cacheRoot, "cache-plan"));
    expect((await stat(cachePath)).size).toBeGreaterThan(44);
    expect(read?.name).toBe("cache-plan");
    expect(stale).toBeNull();
  });

  test("writeFileAtomicViaRename renames the temp file into place", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-atomic-rename-"));
    const target = join(cacheRoot, "apps", "atomic", "plan.bin");
    const renames: Array<{ from: string; to: string }> = [];

    await writeFileAtomicViaRename(target, new Uint8Array([1, 2, 3]), {
      randomId: () => "fixed",
      renameFile: async (from, to) => {
        renames.push({ from, to });
        await (await import("node:fs/promises")).rename(from, to);
      },
    });

    expect(renames).toEqual([{ from: `${target}.tmp-fixed`, to: target }]);
    expect(Array.from(await readFile(target))).toEqual([1, 2, 3]);
  });
});
