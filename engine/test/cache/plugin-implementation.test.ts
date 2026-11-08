import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppPlan, PluginManifest } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import { deriveAppPlanCacheKey, readCachedAppPlan, writeCachedAppPlan } from "../../src/cache/app-plan.ts";
import * as AppCache from "../../src/cache/service.ts";
import { loadInstalledPluginImplementation } from "../../src/plugins/installed-plugin-loader.ts";

test("#2105 plan cache hits unchanged code and misses source edits or a same-version path replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-plan-plugin-"));
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/cache",
    version: "1.0.0",
    api: 4,
    entry: "index.ts",
  });
  const coordinate = async (path: string) => {
    const loaded = await loadInstalledPluginImplementation(path, manifest);
    return {
      name: String(manifest.name),
      source: "user",
      realpath: loaded.implementation.realpath,
      identity: loaded.implementation.identity,
    };
  };
  const input = {
    hostProvider: "lando",
    appRoot: root,
    landofile: { name: "cache-plugin" },
    pluginManifests: [manifest],
  };
  const keyFor = async (path: string) =>
    deriveAppPlanCacheKey({ ...input, pluginImplementations: [await coordinate(path)] });
  try {
    await writeFile(join(root, "index.ts"), 'export { value } from "./implementation.ts";');
    await writeFile(join(root, "implementation.ts"), "export const value = 1;");
    const first = await keyFor(root);
    const plan = Schema.decodeUnknownSync(AppPlan)({
      valueModel: 1,
      id: "cache-plugin",
      name: "cache-plugin",
      slug: "cache-plugin",
      root,
      provider: "lando",
      services: {},
      routes: [],
      stores: [],
      fileSync: [],
      metadata: { resolvedAt: "2026-11-06T00:00:00Z", source: join(root, ".lando.yml"), runtime: 4 },
      extensions: {},
    });
    const cacheRoot = join(root, ".cache");
    await Effect.runPromise(
      writeCachedAppPlan({ cacheRoot, appName: plan.slug, appRoot: root, key: first, plan }).pipe(
        Effect.provide(AppCache.layer),
      ),
    );
    const same = await keyFor(root);
    expect(same).toBe(first);
    expect(
      await Effect.runPromise(readCachedAppPlan({ cacheRoot, appName: plan.slug, appRoot: root, key: same })),
    ).toMatchObject({ name: "cache-plugin" });
    await writeFile(join(root, "implementation.ts"), "export const value = 2;");
    const changed = await keyFor(root);
    expect(changed).not.toBe(first);
    expect(
      await Effect.runPromise(
        readCachedAppPlan({ cacheRoot, appName: plan.slug, appRoot: root, key: changed }),
      ),
    ).toBeNull();
    const alternate = await mkdtemp(join(tmpdir(), "lando-plan-plugin-repoint-"));
    try {
      await writeFile(join(alternate, "index.ts"), "export const value = 3;");
      const repointed = await keyFor(alternate);
      expect(repointed).not.toBe(changed);
      const imported = await loadInstalledPluginImplementation(alternate, manifest);
      expect(imported.value).toMatchObject({ value: 3 });
    } finally {
      await rm(alternate, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
