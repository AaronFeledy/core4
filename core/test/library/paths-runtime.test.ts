import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { makeLandoRuntime } from "@lando/core";
import { ConfigService, PathsService } from "@lando/core/services";

describe("library makeLandoRuntime paths surface", () => {
  test("PathsService is available at bootstrap minimal and resolves roots + a derived path", async () => {
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-paths-data-")));
    const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-paths-cache-")));

    const paths = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* PathsService;
      }).pipe(
        Effect.provide(
          makeLandoRuntime({
            bootstrap: "minimal",
            config: { userDataRoot: dataRoot, userCacheRoot: cacheRoot },
          }),
        ),
      ),
    );

    try {
      expect(paths.roots.userDataRoot).toBe(dataRoot);
      expect(paths.roots.userCacheRoot).toBe(cacheRoot);
      expect(paths.pluginsDir).toBe(join(dataRoot, "plugins"));
      expect(paths.scratchDir).toBe(join(cacheRoot, "scratch"));
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test("config: root overrides relocate every root for an isolated runtime", async () => {
    const confRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-paths-conf-")));
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-paths-data2-")));
    const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-paths-cache2-")));
    const systemRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-paths-sys-")));

    const paths = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* PathsService;
      }).pipe(
        Effect.provide(
          makeLandoRuntime({
            bootstrap: "minimal",
            config: {
              userConfRoot: confRoot,
              userDataRoot: dataRoot,
              userCacheRoot: cacheRoot,
              systemPluginRoot: systemRoot,
            },
          }),
        ),
      ),
    );

    try {
      expect(paths.roots.userConfRoot).toBe(confRoot);
      expect(paths.roots.userDataRoot).toBe(dataRoot);
      expect(paths.roots.userCacheRoot).toBe(cacheRoot);
      expect(paths.roots.systemPluginRoot).toBe(systemRoot);
      expect(paths.binDir).toBe(join(dataRoot, "bin"));
      expect(paths.configFile).toBe(join(confRoot, "config.yml"));
    } finally {
      await rm(confRoot, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
      await rm(systemRoot, { recursive: true, force: true });
    }
  });

  test("ConfigService base derives userCacheRoot and systemPluginRoot from the resolver", async () => {
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-cfg-data-")));
    const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-cfg-cache-")));
    const systemRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-cfg-sys-")));

    const previous = {
      data: process.env.LANDO_USER_DATA_ROOT,
      cache: process.env.LANDO_USER_CACHE_ROOT,
      system: process.env.LANDO_SYSTEM_PLUGIN_ROOT,
    };
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    process.env.LANDO_SYSTEM_PLUGIN_ROOT = systemRoot;

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const config = yield* ConfigService;
          const userCacheRoot = yield* config.get("userCacheRoot");
          const systemPluginRoot = yield* config.get("systemPluginRoot");
          const userDataRoot = yield* config.get("userDataRoot");
          return { userCacheRoot, systemPluginRoot, userDataRoot };
        }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" }))),
      );

      // Base derives all four roots from resolveLandoRoots(); cache/system were undefined before.
      expect(result.userCacheRoot).toBe(cacheRoot);
      expect(result.systemPluginRoot).toBe(systemRoot);
      expect(result.userDataRoot).toBe(dataRoot);
    } finally {
      const restore = (key: keyof typeof previous, envKey: string): void => {
        const value = previous[key];
        if (value === undefined) {
          process.env[envKey] = "";
          Reflect.deleteProperty(process.env, envKey);
        } else {
          process.env[envKey] = value;
        }
      };
      restore("data", "LANDO_USER_DATA_ROOT");
      restore("cache", "LANDO_USER_CACHE_ROOT");
      restore("system", "LANDO_SYSTEM_PLUGIN_ROOT");
      await rm(dataRoot, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
      await rm(systemRoot, { recursive: true, force: true });
    }
  });
});
