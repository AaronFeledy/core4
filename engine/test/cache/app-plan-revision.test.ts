import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serialize } from "node:v8";

import { expect, test } from "bun:test";
import { DateTime, Effect, Schema } from "effect";

import { AbsolutePath, AppId, AppPlan, PluginName, ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  APP_PLAN_CACHE_HEADER_BYTES,
  APP_PLAN_CACHE_MAGIC,
  APP_PLAN_CACHE_SCHEMA_VERSION,
  deriveAppPlanCacheKey,
  readCachedAppPlan,
  writeCachedAppPlan,
} from "../../src/cache/app-plan.ts";
import { appPlanCachePath } from "../../src/cache/paths.ts";
import { CacheServiceLive } from "../../src/cache/service.ts";
import { CORE_VERSION } from "../../src/version.ts";

const runtimeLandofileInput = {
  appRoot: "/workspace/runtime-key",
  landofile: { name: "runtime-key", runtime: 4 as const },
  pluginManifests: [],
};

for (const config of [
  { routerEnabled: false, scanner: null },
  { routerEnabled: true, scanner: { retries: 0 } },
]) {
  test(`changes the cache key when global ${config.scanner === null ? "router enablement" : "scanner"} changes`, () => {
    // Given
    const original = deriveAppPlanCacheKey({
      ...runtimeLandofileInput,
      config: { routerEnabled: true, scanner: null },
    });
    // When
    const changed = deriveAppPlanCacheKey({ ...runtimeLandofileInput, config });
    // Then
    expect(changed).not.toBe(original);
  });
}

const runtimeAppPlan: AppPlan = {
  id: AppId.make("runtime-key"),
  name: "runtime-key",
  slug: "runtime-key",
  root: AbsolutePath.make("/workspace/runtime-key"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-05-20T00:00:00Z"),
    source: "/workspace/runtime-key/.lando.yml",
    runtime: 4,
  },
  extensions: {},
};

const runWithCache = <A, E>(effect: Effect.Effect<A, E, import("@lando/sdk/services").CacheService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(CacheServiceLive)));

test("ignores a valid revision-6 app plan without pinned PHP prerequisite identities", async () => {
  // Given
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-v6-"));
  const appRoot = "/workspace/redirect-app";
  const appName = "redirect-app";
  const key = "revision-6-key";
  const serviceName = ServiceName.make("web");
  const metadata = {
    resolvedAt: DateTime.unsafeMake("2026-07-21T00:00:00Z"),
    source: `${appRoot}/.lando.yml`,
    runtime: 4 as const,
  };
  const oldPlan = Schema.encodeSync(AppPlan)({
    id: AppId.make(appName),
    name: appName,
    slug: appName,
    root: AbsolutePath.make(appRoot),
    provider: ProviderId.make("lando"),
    services: {
      [serviceName]: {
        name: serviceName,
        type: "apache",
        provider: ProviderId.make("lando"),
        primary: true,
        environment: {},
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {
          "@lando/core/service-features": {
            buildSteps: [
              {
                id: "lando-log-redirect:access",
                phase: "build",
                command: ["ln", "-sf", "/dev/stdout", "/usr/local/apache2/logs/access_log"],
              },
              {
                id: "lando-log-redirect:error",
                phase: "build",
                command: ["ln", "-sf", "/dev/stderr", "/usr/local/apache2/logs/error_log"],
              },
            ],
          },
        },
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  });
  const body = serialize({
    schemaVersion: 6,
    landoVersion: CORE_VERSION,
    key,
    versionConstraints: [],
    generatedAtMs: 1,
    plan: oldPlan,
  });
  const header = Buffer.alloc(APP_PLAN_CACHE_HEADER_BYTES);
  APP_PLAN_CACHE_MAGIC.copy(header, 0);
  header.writeBigUInt64BE(6n, 4);
  createHash("sha256").update(body).digest().copy(header, 12);
  const persisted = Buffer.concat([header, body]);
  const path = appPlanCachePath(cacheRoot, appName, appRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, persisted);

  // When
  const read = await Effect.runPromise(readCachedAppPlan({ cacheRoot, appName, appRoot, key }));

  // Then
  expect(read).toBeNull();
  expect(await readFile(path)).toEqual(persisted);
});

test("includes revision 16 in the app-plan cache key", () => {
  // Given
  const input = {
    appRoot: "/workspace/revision-key",
    landofile: { name: "revision-key", runtime: 4 as const },
    pluginManifests: [],
  };

  // When
  const key = deriveAppPlanCacheKey(input);

  // Then
  expect(APP_PLAN_CACHE_SCHEMA_VERSION).toBe(16n);
  expect(key).not.toBe("b7ee8b58156c17f30d73e11f3560e06267bc1961746b424e033b7a4885f98487");
});

test("changes the app-plan cache key when env-file content or resolved path changes", () => {
  // Given
  const input = {
    appRoot: "/workspace/env-key",
    landofile: { name: "env-key", runtime: 4 as const },
    pluginManifests: [],
  };

  // When
  const original = deriveAppPlanCacheKey({
    ...input,
    serviceInputs: { envFileInputs: [{ source: "/workspace/env-key/.env", hash: "first" }] },
  });
  const changedContent = deriveAppPlanCacheKey({
    ...input,
    serviceInputs: { envFileInputs: [{ source: "/workspace/env-key/.env", hash: "second" }] },
  });
  const changedPath = deriveAppPlanCacheKey({
    ...input,
    serviceInputs: { envFileInputs: [{ source: "/workspace/env-key/other.env", hash: "first" }] },
  });

  // Then
  expect(changedContent).not.toBe(original);
  expect(changedPath).not.toBe(original);
});

test("keeps the app-plan cache key and hits plan.bin when planning runtime and Landofile are unchanged", async () => {
  // Given
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-runtime-hit-"));
  const appRoot = runtimeLandofileInput.appRoot;
  const appName = "runtime-key";
  const first = deriveAppPlanCacheKey({ ...runtimeLandofileInput, planningRuntime: "runtime-a" });
  const second = deriveAppPlanCacheKey({ ...runtimeLandofileInput, planningRuntime: "runtime-a" });

  // When
  const cachePath = await runWithCache(
    writeCachedAppPlan({
      cacheRoot,
      appName,
      appRoot,
      key: first,
      plan: runtimeAppPlan,
      now: () => 1,
    }),
  );
  const read = await Effect.runPromise(readCachedAppPlan({ cacheRoot, appName, appRoot, key: second }));

  // Then
  expect(first).toBe(second);
  expect(cachePath).toBe(appPlanCachePath(cacheRoot, appName, appRoot));
  expect(read?.name).toBe("runtime-key");
});

test("misses plan.bin when the planning runtime fingerprint changes", async () => {
  // Given
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-runtime-miss-"));
  const appRoot = runtimeLandofileInput.appRoot;
  const appName = "runtime-key";
  const writtenKey = deriveAppPlanCacheKey({ ...runtimeLandofileInput, planningRuntime: "runtime-a" });
  const nextKey = deriveAppPlanCacheKey({ ...runtimeLandofileInput, planningRuntime: "runtime-b" });
  const cachePath = await runWithCache(
    writeCachedAppPlan({
      cacheRoot,
      appName,
      appRoot,
      key: writtenKey,
      plan: runtimeAppPlan,
      now: () => 1,
    }),
  );

  // When
  const read = await Effect.runPromise(readCachedAppPlan({ cacheRoot, appName, appRoot, key: nextKey }));

  // Then
  expect(nextKey).not.toBe(writtenKey);
  expect(read).toBeNull();
  expect((await readFile(cachePath)).length).toBeGreaterThan(0);
});

test("does not change the app-plan cache key for env, host, or template inputs", () => {
  // Given
  const probe = "LANDO_PLAN_CACHE_ENV_PROBE";
  const previous = process.env[probe];
  const baseline = deriveAppPlanCacheKey({ ...runtimeLandofileInput, planningRuntime: "runtime-a" });

  // When
  process.env[probe] = "1";
  const afterEnvSet = deriveAppPlanCacheKey({ ...runtimeLandofileInput, planningRuntime: "runtime-a" });
  delete process.env[probe];
  const afterEnvDelete = deriveAppPlanCacheKey({ ...runtimeLandofileInput, planningRuntime: "runtime-a" });
  if (previous === undefined) {
    delete process.env[probe];
  } else {
    process.env[probe] = previous;
  }
  const pluginVersionChanged = deriveAppPlanCacheKey({
    ...runtimeLandofileInput,
    planningRuntime: "runtime-a",
    pluginManifests: [
      {
        name: PluginName.make("@lando/node"),
        version: "1.0.1",
        api: 4 as const,
        bootstrap: "app",
        contributes: { serviceTypes: ["node"] },
      },
    ],
  });
  const envFileChanged = deriveAppPlanCacheKey({
    ...runtimeLandofileInput,
    planningRuntime: "runtime-a",
    serviceInputs: { envFileInputs: [{ source: "/workspace/runtime-key/.env", hash: "second" }] },
  });

  // Then
  expect(afterEnvSet).toBe(baseline);
  expect(afterEnvDelete).toBe(baseline);
  expect(pluginVersionChanged).not.toBe(baseline);
  expect(envFileChanged).not.toBe(baseline);
});

for (const router of [undefined, { enabled: true }, { enabled: false }] as const) {
  const label = router === undefined ? "omits router" : `sets router.enabled ${router.enabled}`;
  test(`derives the shared-router requirement from enablement when a cached plan ${label}`, async () => {
    // Given: a persisted plan that declares a route but no global-service requirement.
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-router-"));
    const appRoot = "/workspace/router-cache";
    const service = ServiceName.make("web");
    const routedPlan: AppPlan = {
      ...runtimeAppPlan,
      id: AppId.make("router-cache"),
      name: "router-cache",
      slug: "router-cache",
      root: AbsolutePath.make(appRoot),
      ...(router === undefined ? {} : { router }),
      routes: [
        {
          hostname: "router-cache.lndo.site",
          scheme: "https",
          service,
          backend: { service, protocol: "http", port: 8080 },
        },
      ],
    };
    await runWithCache(
      writeCachedAppPlan({
        cacheRoot,
        appName: "router-cache",
        appRoot,
        key: "router-key",
        plan: routedPlan,
        now: () => 1,
      }),
    );

    // When
    const read = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "router-cache", appRoot, key: "router-key" }),
    );

    // Then: a disabled router must not auto-start the shared router on the next start.
    expect(read?.routes).toHaveLength(1);
    expect(read?.requires?.globalServices ?? []).toEqual(router?.enabled === false ? [] : ["traefik"]);
  });
}
