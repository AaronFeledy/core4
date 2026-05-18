import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { CommandRegistry } from "@lando/core/services";

import { decodeAppCommandIndex, decodePluginCommandIndex } from "../../src/cache/command-index.ts";
import { appCommandCachePath, pluginCommandCachePath } from "../../src/cache/paths.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { CommandRegistryLive } from "../../src/services/command-registry.ts";

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-command-registry-"));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

const withTempCacheRoot = async <T>(run: (cacheRoot: string) => Promise<T>): Promise<T> => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-command-cache-"));
  const previous = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  try {
    return await run(cacheRoot);
  } finally {
    // biome-ignore lint/performance/noDelete: process.env delete is required for correct cleanup on Windows (Bun sets undefined as string "undefined" otherwise)
    if (previous === undefined) delete process.env.LANDO_USER_CACHE_ROOT;
    else process.env.LANDO_USER_CACHE_ROOT = previous;
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const registryLayer = Layer.provide(CommandRegistryLive, LandofileServiceLive);

const listFromLive = () =>
  Effect.runPromise(
    Effect.flatMap(CommandRegistry, (registry) => registry.list).pipe(Effect.provide(registryLayer)),
  );

const listFromBootstrap = () =>
  Effect.runPromise(
    Effect.flatMap(CommandRegistry, (registry) => registry.list).pipe(
      Effect.provide(makeLandoRuntime({ bootstrap: "tooling" })),
    ),
  );

describe("CommandRegistryLive", () => {
  test("lists parsed tooling tasks as RegisteredCommand entries under the app: namespace", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "tooling:",
          "  composer:",
          "    description: Run Composer in the appserver",
          "    service: appserver",
          "    cmd: composer",
          "  test:",
          "    description: Run the test suite",
          "    service: appserver",
          "    cmds:",
          "      - composer install",
          "      - phpunit",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const commands = await listFromLive();
      const ids = commands.map((c) => c.id).sort();
      expect(ids).toEqual(["app:composer", "app:test"]);

      const composer = commands.find((c) => c.id === "app:composer");
      expect(composer?.summary).toBe("Run Composer in the appserver");
      expect(composer?.hidden).toBe(false);

      const t = commands.find((c) => c.id === "app:test");
      expect(t?.summary).toBe("Run the test suite");
    });
  });

  test("returns an empty list when no Landofile is present (router-bootstrap-omits-tooling contract)", async () => {
    await withTempCwd(async (dir) => {
      process.chdir(dir);
      const commands = await listFromLive();
      expect(commands).toEqual([]);
    });
  });

  test("returns an empty list when Landofile parse fails (Beta-deferred surface, no rejection at registry layer)", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: myapp", "includes:", "  - ./fragment.yml", ""].join("\n"),
      );
      process.chdir(dir);

      const commands = await listFromLive();
      expect(commands).toEqual([]);
    });
  });

  test("returns an empty list when the Landofile has no `tooling:` section", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: myapp", "services:", "  web:", "    image: node:lts", ""].join("\n"),
      );
      process.chdir(dir);

      const commands = await listFromLive();
      expect(commands).toEqual([]);
    });
  });

  test("uses `summary:` when `description:` is absent", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: myapp", "tooling:", "  build:", "    summary: Build everything", "    cmd: make", ""].join(
          "\n",
        ),
      );
      process.chdir(dir);

      const commands = await listFromLive();
      const build = commands.find((c) => c.id === "app:build");
      expect(build?.summary).toBe("Build everything");
    });
  });

  test("makeLandoRuntime({ bootstrap: 'tooling' }) provides CommandRegistry populated from the Landofile", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "tooling:",
          "  build:",
          "    description: Build assets",
          "    service: appserver",
          "    cmd: make",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const commands = await listFromBootstrap();
      expect(commands.map((c) => c.id)).toEqual(["app:build"]);
      expect(commands[0]?.summary).toBe("Build assets");
    });
  });
});

describe("CommandRegistryLive cold-path cache writes", () => {
  let previousCwd = process.cwd();

  beforeEach(() => {
    previousCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(previousCwd);
  });

  test("writes the §12.1 app-command cache after a successful Landofile discovery", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        await writeFile(
          join(dir, ".lando.yml"),
          [
            "name: cache-app",
            "tooling:",
            "  composer:",
            "    description: Run Composer",
            "    service: appserver",
            "    cmd: composer",
            "  test:",
            "    summary: Run tests",
            "    service: appserver",
            "    cmds:",
            "      - composer install",
            "      - phpunit",
            "",
          ].join("\n"),
        );
        process.chdir(dir);

        const commands = await listFromLive();
        expect(commands.map((c) => c.id).sort()).toEqual(["app:composer", "app:test"]);

        const cachePath = appCommandCachePath(cacheRoot, "cache-app");
        const bytes = new Uint8Array(await readFile(cachePath));
        const decoded = decodeAppCommandIndex(bytes);
        expect(decoded).not.toBeNull();
        if (decoded === null) return;
        expect(decoded.appName).toBe("cache-app");
        expect(decoded.sourceFile).toBe(join(dir, ".lando.yml"));
        expect(decoded.sourceSize).toBeGreaterThan(0);
        expect(decoded.sourceMtimeMs).toBeGreaterThan(0);
        expect(decoded.entries.map((entry) => entry.id).sort()).toEqual(["app:composer", "app:test"]);
        const composer = decoded.entries.find((entry) => entry.id === "app:composer");
        expect(composer?.summary).toBe("Run Composer");
        expect(composer?.service).toBe("appserver");
      });
    });
  });

  test("writes the §12.1 plugin-command cache regardless of Landofile presence", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        process.chdir(dir);

        const commands = await listFromLive();
        expect(commands).toEqual([]);

        const cachePath = pluginCommandCachePath(cacheRoot);
        const bytes = new Uint8Array(await readFile(cachePath));
        const decoded = decodePluginCommandIndex(bytes);
        expect(decoded).not.toBeNull();
        if (decoded === null) return;
        expect(decoded.schemaVersion).toBe(1);
        expect(decoded.pluginNames.length).toBeGreaterThan(0);
        expect(Array.isArray(decoded.entries)).toBe(true);
      });
    });
  });

  test("uses appName 'unnamed' in the cache path when the Landofile omits `name`", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        await writeFile(
          join(dir, ".lando.yml"),
          ["tooling:", "  build:", "    service: appserver", "    cmd: make", ""].join("\n"),
        );
        process.chdir(dir);

        const commands = await listFromLive();
        expect(commands.map((c) => c.id)).toEqual(["app:build"]);

        const cachePath = appCommandCachePath(cacheRoot, "unnamed");
        const bytes = new Uint8Array(await readFile(cachePath));
        const decoded = decodeAppCommandIndex(bytes);
        expect(decoded?.appName).toBe("unnamed");
      });
    });
  });

  test("returns commands even when cache write fails (best-effort contract)", async () => {
    await withTempCwd(async (dir) => {
      const previous = process.env.LANDO_USER_CACHE_ROOT;
      process.env.LANDO_USER_CACHE_ROOT = "/proc/lando-impossible-cache-root";
      try {
        await writeFile(
          join(dir, ".lando.yml"),
          ["name: still-works", "tooling:", "  build:", "    service: appserver", "    cmd: make", ""].join(
            "\n",
          ),
        );
        process.chdir(dir);

        const commands = await listFromLive();
        expect(commands.map((c) => c.id)).toEqual(["app:build"]);
      } finally {
        // biome-ignore lint/performance/noDelete: process.env delete is required for correct cleanup on Windows (Bun sets undefined as string "undefined" otherwise)
        if (previous === undefined) delete process.env.LANDO_USER_CACHE_ROOT;
        else process.env.LANDO_USER_CACHE_ROOT = previous;
      }
    });
  });
});
