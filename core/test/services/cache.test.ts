import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";

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
import {
  APP_PLAN_CACHE_HEADER_BYTES,
  deriveAppPlanCacheKey,
  readCachedAppPlan,
  writeCachedAppPlan,
} from "../../src/cache/app-plan.ts";
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

const expectExitFailure = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected effect to fail");
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) throw new Error("expected effect to fail with a typed failure");
  return failure.value;
};

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
  fileSync: [],
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
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
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

    const failure = expectExitFailure(exit);
    expect(failure).toBeInstanceOf(CacheError);
    expect(failure).toMatchObject({
      _tag: "CacheError",
      key: "bad",
    });
    expect(failure.decodeError).toBeDefined();
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
    const decoded = deserialize(payload) as {
      landoVersion: string;
      entries: unknown[];
    };
    const rewritten = serialize({ ...decoded, landoVersion: "0.0.0-bogus" });
    const newHeader = Buffer.from(header);
    createHash("sha256").update(rewritten).digest().copy(newHeader, 12);
    await writeFile(cacheFile, Buffer.concat([newHeader, rewritten]));

    const listed = await Effect.runPromise(listCwdAppMapEntries(cacheRoot));
    expect(listed).toEqual([]);
  });

  test("fails corrupt cwd-app-map reads with a remediation message", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-cwd-app-map-corrupt-"));
    await writeFile(join(cacheRoot, CWD_APP_MAP_CACHE_FILE), "not a valid binary cache");

    const exit = await Effect.runPromiseExit(listCwdAppMapEntries(cacheRoot));

    const failure = expectExitFailure(exit);
    expect(failure).toBeInstanceOf(CacheError);
    expect(failure.message).toContain("run `lando app:cache:refresh`");
  });

  test("derives app-plan cache keys from Landofile, plugin, provider, and app-root inputs", () => {
    const base = {
      appRoot: "/workspace/cache-plan",
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
    ).toBe(key);
    expect(
      deriveAppPlanCacheKey({
        ...base,
        landofile: { ...base.landofile, provider: ProviderId.make("docker") },
      }),
    ).not.toBe(key);
    expect(deriveAppPlanCacheKey({ ...base, includedFragmentShas: ["a".repeat(64)] })).not.toBe(key);
    expect(deriveAppPlanCacheKey({ ...base, appRoot: "/workspace/other-root" })).not.toBe(key);
    expect(
      deriveAppPlanCacheKey({
        ...base,
        serviceInputs: {
          landofile: base.landofile.services ?? {},
          composition: { services: [], appFeatures: [] },
        },
      }),
    ).not.toBe(key);
    expect(
      deriveAppPlanCacheKey({
        ...base,
        serviceInputs: {
          landofile: base.landofile.services ?? {},
          composition: { services: [], appFeatures: [] },
        },
      }),
    ).not.toBe(deriveAppPlanCacheKey({ ...base, landofile: { name: "cache-plan", services: {} } }));
  });

  test("writes and reads app-plan caches through CacheService.writeAtomic", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-cache-"));
    const appRoot = "/workspace/cache-plan";
    const key = "app-plan-key";

    const cachePath = await runWithCache(
      writeCachedAppPlan({
        cacheRoot,
        appName: "cache-plan",
        appRoot,
        key,
        plan: appPlanFixture,
        now: () => 1,
      }),
    );
    const read = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "cache-plan", appRoot, key }),
    );
    const stale = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "cache-plan", appRoot, key: "different" }),
    );

    expect(cachePath).toBe(appPlanCachePath(cacheRoot, "cache-plan", appRoot));
    expect((await stat(cachePath)).size).toBeGreaterThan(44);
    expect(read?.name).toBe("cache-plan");
    expect(stale).toBeNull();
  });

  test("treats app-plan caches without version-constraint provenance as stale", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-cache-legacy-"));
    const appRoot = "/workspace/cache-plan";
    const key = "app-plan-key";

    const cachePath = await runWithCache(
      writeCachedAppPlan({
        cacheRoot,
        appName: "cache-plan",
        appRoot,
        key,
        plan: appPlanFixture,
        now: () => 1,
      }),
    );
    const original = Buffer.from(await readFile(cachePath));
    const payload = deserialize(original.subarray(APP_PLAN_CACHE_HEADER_BYTES)) as Record<string, unknown>;
    const { versionConstraints: _discard, ...legacyPayload } = payload;
    const body = Buffer.from(serialize(legacyPayload));
    const header = Buffer.from(original.subarray(0, APP_PLAN_CACHE_HEADER_BYTES));
    createHash("sha256").update(body).digest().copy(header, 12);
    await writeFile(cachePath, Buffer.concat([header, body]));

    const read = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "cache-plan", appRoot, key }),
    );

    expect(read).toBeNull();
  });

  test("treats app-plan caches with unsatisfied version constraints as stale", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-cache-version-"));
    const appRoot = "/workspace/cache-plan";
    const key = "app-plan-key";

    await runWithCache(
      writeCachedAppPlan({
        cacheRoot,
        appName: "cache-plan",
        appRoot,
        key,
        plan: appPlanFixture,
        versionConstraints: [{ range: ">=99", source: ".lando.yml" }],
        now: () => 1,
      }),
    );

    const read = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "cache-plan", appRoot, key }),
    );

    expect(read).toBeNull();
  });

  test("treats app-plan caches with malformed version-constraint provenance as stale", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-cache-malformed-version-"));
    const appRoot = "/workspace/cache-plan";
    const key = "app-plan-key";

    const cachePath = await runWithCache(
      writeCachedAppPlan({
        cacheRoot,
        appName: "cache-plan",
        appRoot,
        key,
        plan: appPlanFixture,
        now: () => 1,
      }),
    );
    const original = Buffer.from(await readFile(cachePath));
    const payload = deserialize(original.subarray(APP_PLAN_CACHE_HEADER_BYTES)) as Record<string, unknown>;
    const body = Buffer.from(serialize({ ...payload, versionConstraints: [{}] }));
    const header = Buffer.from(original.subarray(0, APP_PLAN_CACHE_HEADER_BYTES));
    createHash("sha256").update(body).digest().copy(header, 12);
    await writeFile(cachePath, Buffer.concat([header, body]));

    const read = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "cache-plan", appRoot, key }),
    );

    expect(read).toBeNull();
  });

  test("derives route global-service requirements when reading cached app plans", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-routed-cache-"));
    const appRoot = "/workspace/routed-cache-plan";
    const key = "app-plan-key";
    const routedPlan = {
      ...appPlanFixture,
      root: AbsolutePath.make(appRoot),
      routes: [
        {
          hostname: "web.cache-plan.lndo.site",
          scheme: "https" as const,
          service: ServiceName.make("web"),
        },
      ],
    };

    await runWithCache(
      writeCachedAppPlan({
        cacheRoot,
        appName: "cache-plan",
        appRoot,
        key,
        plan: routedPlan,
        now: () => 1,
      }),
    );

    const read = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "cache-plan", appRoot, key }),
    );

    expect(read?.routes).toHaveLength(1);
    expect(read?.requires?.globalServices).toEqual(["traefik"]);
  });

  test("namespaces app-plan caches per app root to prevent cross-project collisions", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-cross-"));
    const rootA = "/workspace/proj-a";
    const rootB = "/workspace/proj-b";

    const pathA = await runWithCache(
      writeCachedAppPlan({
        cacheRoot,
        appName: "shared-name",
        appRoot: rootA,
        key: "key-a",
        plan: appPlanFixture,
        now: () => 1,
      }),
    );
    const pathB = await runWithCache(
      writeCachedAppPlan({
        cacheRoot,
        appName: "shared-name",
        appRoot: rootB,
        key: "key-b",
        plan: appPlanFixture,
        now: () => 2,
      }),
    );

    expect(pathA).not.toBe(pathB);
    expect((await stat(pathA)).size).toBeGreaterThan(44);
    expect((await stat(pathB)).size).toBeGreaterThan(44);

    const readA = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "shared-name", appRoot: rootA, key: "key-a" }),
    );
    const readB = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "shared-name", appRoot: rootB, key: "key-b" }),
    );
    const crossAtoB = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "shared-name", appRoot: rootA, key: "key-b" }),
    );

    expect(readA?.name).toBe("cache-plan");
    expect(readB?.name).toBe("cache-plan");
    expect(crossAtoB).toBeNull();
  });

  test("writeFileAtomicViaRename renames the temp file into place", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-atomic-rename-"));
    const target = join(cacheRoot, "apps", "atomic", "plan.bin");
    const renames: Array<{ from: string; to: string }> = [];

    await writeFileAtomicViaRename(target, new Uint8Array([1, 2, 3]), {
      randomId: () => "fixed",
      renameFile: async (from, to) => {
        renames.push({ from, to });
        await rename(from, to);
      },
    });

    expect(renames).toEqual([{ from: `${target}.tmp-fixed`, to: target }]);
    expect(Array.from(await readFile(target))).toEqual([1, 2, 3]);
  });
});
