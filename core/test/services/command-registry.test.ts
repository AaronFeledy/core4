import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { CommandRegistry, type RegisteredCommand } from "@lando/core/services";
import { CacheError } from "@lando/sdk/errors";
import type { PluginManifest } from "@lando/sdk/schema";

import {
  readAppCommandCache,
  readPluginCommandCache,
  writeAppCommandCache,
  writeAppCommandCacheStrict,
  writePluginCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import { decodeAppCommandIndex, decodePluginCommandIndex } from "../../src/cache/command-index.ts";
import {
  appCommandCachePath,
  appToolingCompilationCachePath,
  pluginCommandCachePath,
} from "../../src/cache/paths.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { CommandRegistryLive } from "../../src/services/command-registry.ts";

const writeScript = async (appRoot: string, relativePath: string, contents: string): Promise<void> => {
  const target = join(appRoot, ".lando", "scripts", relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents);
};

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
    ) as Effect.Effect<ReadonlyArray<RegisteredCommand>, never, never>,
  );

const manifest = (name: string, commands: ReadonlyArray<string>, version = "0.0.0"): PluginManifest => ({
  name: name as PluginManifest["name"],
  version,
  api: 4,
  contributes: { commands },
});

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

  test("returns an empty list when Landofile parse fails", async () => {
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

  test("lists auto-discovered .bun.sh script-backed tasks alongside Landofile tooling tasks", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "tooling:",
          "  composer:",
          "    description: Run Composer",
          "    service: appserver",
          "    cmd: composer",
          "",
        ].join("\n"),
      );
      await writeScript(
        dir,
        "build.bun.sh",
        ["# ---", "# desc: Build the app", "# ---", "console.log('build');", ""].join("\n"),
      );
      await writeScript(
        dir,
        join("db", "wait.bun.sh"),
        ["# ---", "# desc: Wait for the DB", "# ---", "console.log('wait');", ""].join("\n"),
      );
      process.chdir(dir);

      const commands = await listFromLive();
      const ids = commands.map((c) => c.id).sort();
      expect(ids).toEqual(["app:build", "app:composer", "app:db:wait"]);
      expect(commands.find((c) => c.id === "app:build")?.summary).toBe("Build the app");
      expect(commands.find((c) => c.id === "app:db:wait")?.summary).toBe("Wait for the DB");
    });
  });

  test("Landofile tooling.<id> wins over an auto-discovered script with the same canonical id", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "tooling:",
          "  build:",
          "    description: Landofile build wins",
          "    service: appserver",
          "    cmd: make",
          "",
        ].join("\n"),
      );
      await writeScript(
        dir,
        "build.bun.sh",
        [
          "# ---",
          "# desc: Script-backed build (should be overridden)",
          "# ---",
          "console.log('script');",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const commands = await listFromLive();
      const build = commands.find((c) => c.id === "app:build");
      expect(build?.summary).toBe("Landofile build wins");
    });
  });

  test("returns Landofile-only entries when a .bun.sh script is malformed (router-bootstrap stays best-effort)", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "tooling:",
          "  test:",
          "    description: Run tests",
          "    service: appserver",
          "    cmd: phpunit",
          "",
        ].join("\n"),
      );
      await writeScript(dir, "broken.bun.sh", ["console.log('no front matter');", ""].join("\n"));
      process.chdir(dir);

      const commands = await listFromLive();
      expect(commands.map((c) => c.id)).toEqual(["app:test"]);
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

  test("reuses a fresh app-command cache without recompiling discovered command entries", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const landofile = { name: "warm-app", tooling: { build: { cmd: "make" } } };
        await writeFile(
          join(dir, ".lando.yml"),
          ["name: warm-app", "tooling:", "  build:", "    cmd: make", ""].join("\n"),
        );
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile,
            entries: [{ id: "app:cached-only", summary: "from cache", hidden: false }],
            cwd: dir,
            cacheRoot,
            now: () => 100,
          }),
        );
        process.chdir(dir);

        const commands = await listFromLive();

        expect(commands.map((c) => c.id)).toEqual(["app:cached-only"]);
        expect(commands[0]?.summary).toBe("from cache");
      });
    });
  });

  test("invalidates the warm tooling cache when .bun.sh scripts change", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const landofile = { name: "script-warm-cache", tooling: { build: { cmd: "make" } } };
        await writeFile(
          join(dir, ".lando.yml"),
          ["name: script-warm-cache", "tooling:", "  build:", "    cmd: make", ""].join("\n"),
        );
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile,
            entries: [{ id: "app:cached-only", summary: "from cache", hidden: false }],
            cwd: dir,
            cacheRoot,
            now: () => 100,
          }),
        );
        await writeScript(
          dir,
          "deploy.bun.sh",
          ["# ---", "# desc: Deploy the app", "# ---", "console.log('deploy');", ""].join("\n"),
        );
        process.chdir(dir);

        const commands = await listFromLive();

        expect(commands.map((c) => c.id).sort()).toEqual(["app:build", "app:deploy"]);
        expect(commands.find((c) => c.id === "app:deploy")?.summary).toBe("Deploy the app");
      });
    });
  });

  test("materializes the tooling-compilation cache when only the legacy app-command cache exists", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const landofile = { name: "legacy-app", tooling: { build: { cmd: "make" } } };
        await writeFile(
          join(dir, ".lando.yml"),
          ["name: legacy-app", "tooling:", "  build:", "    cmd: make", ""].join("\n"),
        );
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile,
            entries: [{ id: "app:build", summary: "", hidden: false }],
            cwd: dir,
            cacheRoot,
            now: () => 100,
          }),
        );
        const toolingCachePath = appToolingCompilationCachePath(cacheRoot, dir);
        await unlink(toolingCachePath);
        process.chdir(dir);

        const commands = await listFromLive();
        const bytes = new Uint8Array(await readFile(toolingCachePath));
        const decoded = decodeAppCommandIndex(bytes);

        expect(commands.map((c) => c.id)).toEqual(["app:build"]);
        expect(decoded?.entries.map((entry) => entry.id)).toEqual(["app:build"]);
        expect(typeof decoded?.sourceContentHash).toBe("string");
      });
    });
  });

  test("invalidates the app-command cache when services change", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const landofilePath = join(dir, ".lando.yml");
        await writeFile(
          landofilePath,
          [
            "name: service-cache",
            "services:",
            "  web:",
            "    type: node",
            "tooling:",
            "  build:",
            "    service: web",
            "    cmd: make",
            "",
          ].join("\n"),
        );
        const cachedLandofile = {
          name: "service-cache",
          services: { web: { type: "node" } },
          tooling: { build: { service: "web", cmd: "make" } },
        };
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile: cachedLandofile,
            entries: [{ id: "app:stale", summary: "stale", hidden: false, service: "web" }],
            cwd: dir,
            cacheRoot,
            now: () => 100,
          }),
        );
        await writeFile(
          landofilePath,
          [
            "name: service-cache",
            "services:",
            "  appserver:",
            "    type: node",
            "tooling:",
            "  build:",
            "    service: appserver",
            "    cmd: make",
            "",
          ].join("\n"),
        );
        process.chdir(dir);

        const commands = await listFromLive();

        expect(commands.map((c) => c.id)).toEqual(["app:build"]);
      });
    });
  });

  test("invalidates the app-command cache when include lock content changes", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const landofile = {
          name: "include-cache",
          includes: [{ source: "./fragment.yml" }],
          tooling: { build: { cmd: "make" } },
        };
        await writeFile(
          join(dir, ".lando.yml"),
          [
            "name: include-cache",
            "includes:",
            "  - source: ./fragment.yml",
            "tooling:",
            "  build:",
            "    cmd: make",
            "",
          ].join("\n"),
        );
        await writeFile(
          join(dir, ".lando.lock.yml"),
          "checksum: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        );
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile,
            entries: [{ id: "app:stale", summary: "stale", hidden: false }],
            cwd: dir,
            cacheRoot,
            now: () => 100,
          }),
        );
        await writeFile(
          join(dir, ".lando.lock.yml"),
          "checksum: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        );
        process.chdir(dir);

        const commands = await listFromLive();

        expect(commands.map((c) => c.id)).toEqual(["app:build"]);
      });
    });
  });

  test("writes the app-command cache after a successful Landofile discovery", async () => {
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

        const cachePath = appCommandCachePath(cacheRoot, "cache-app", dir);
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

  test("writes the plugin-command cache regardless of Landofile presence", async () => {
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

  test("reuses a fresh plugin-command cache and invalidates it when plugin manifests change", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const firstManifests = [manifest("@lando/a", ["a:one"])] as const;
      const secondManifests = [manifest("@lando/a", ["a:two"])] as const;

      const firstPath = await Effect.runPromise(
        writePluginCommandCacheStrict({ manifests: firstManifests, cacheRoot, now: () => 100 }),
      );
      const first = await Effect.runPromise(readPluginCommandCache({ manifests: firstManifests, cacheRoot }));
      expect(first?.entries.map((entry) => entry.id)).toEqual(["a:one"]);

      await Effect.runPromise(
        writePluginCommandCacheStrict({ manifests: firstManifests, cacheRoot, now: () => 200 }),
      );
      const reused = decodePluginCommandIndex(new Uint8Array(await readFile(firstPath)));
      expect(reused?.generatedAtMs).toBe(100);

      const stale = await Effect.runPromise(
        readPluginCommandCache({ manifests: secondManifests, cacheRoot }),
      );
      expect(stale).toBeNull();

      await Effect.runPromise(
        writePluginCommandCacheStrict({ manifests: secondManifests, cacheRoot, now: () => 300 }),
      );
      const refreshed = decodePluginCommandIndex(new Uint8Array(await readFile(firstPath)));
      expect(refreshed?.generatedAtMs).toBe(300);
      expect(refreshed?.entries.map((entry) => entry.id)).toEqual(["a:two"]);
    });
  });

  test("invalidates app-command cache when Landofile tooling changes", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const landofile = { name: "tooling-cache", tooling: { build: { cmd: "make" } } };
        await writeFile(
          join(dir, ".lando.yml"),
          ["name: tooling-cache", "tooling:", "  build:", "    cmd: make", ""].join("\n"),
        );

        await Effect.runPromise(
          writeAppCommandCache({
            landofile,
            entries: [{ id: "app:build", summary: "", hidden: false }],
            cwd: dir,
            cacheRoot,
            now: () => 100,
          }),
        );

        const fresh = await Effect.runPromise(
          readAppCommandCache({
            landofile,
            entries: [{ id: "app:build", summary: "", hidden: false }],
            cwd: dir,
            cacheRoot,
          }),
        );
        expect(fresh?.entries.map((entry) => entry.id)).toEqual(["app:build"]);

        const stale = await Effect.runPromise(
          readAppCommandCache({
            landofile: { name: "tooling-cache", tooling: { test: { cmd: "bun test" } } },
            entries: [{ id: "app:test", summary: "", hidden: false }],
            cwd: dir,
            cacheRoot,
          }),
        );
        expect(stale).toBeNull();
      });
    });
  });

  test("invalidates app-command cache when discovered command entries change", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const landofile = { name: "script-cache", tooling: { composer: { cmd: "composer" } } };
        await writeFile(
          join(dir, ".lando.yml"),
          ["name: script-cache", "tooling:", "  composer:", "    cmd: composer", ""].join("\n"),
        );

        const firstPath = await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile,
            entries: [{ id: "app:composer", summary: "", hidden: false }],
            cwd: dir,
            cacheRoot,
            now: () => 100,
          }),
        );

        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile,
            entries: [
              { id: "app:composer", summary: "", hidden: false },
              { id: "app:db:wait", summary: "Wait for the DB", hidden: false, service: ":host" },
            ],
            cwd: dir,
            cacheRoot,
            now: () => 200,
          }),
        );

        if (firstPath === undefined) return;
        const refreshed = decodeAppCommandIndex(new Uint8Array(await readFile(firstPath)));
        expect(refreshed?.generatedAtMs).toBe(200);
        expect(refreshed?.entries.map((entry) => entry.id).sort()).toEqual(["app:composer", "app:db:wait"]);
      });
    });
  });

  test("reports a tagged error when required bundled plugin manifests are missing", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const exit = await Effect.runPromiseExit(
        writePluginCommandCacheStrict({
          manifests: [manifest("@lando/present", ["present:cmd"])],
          pluginNames: ["@lando/present", "@lando/missing"],
          cacheRoot,
        }),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(failure).toBeInstanceOf(CacheError);
      expect(failure?.message).toContain("@lando/missing");
    });
  });

  test("writes auto-discovered .bun.sh script-backed entries into the app-command cache", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        await writeFile(
          join(dir, ".lando.yml"),
          [
            "name: scripted-app",
            "tooling:",
            "  composer:",
            "    description: Run Composer",
            "    service: appserver",
            "    cmd: composer",
            "",
          ].join("\n"),
        );
        await writeScript(
          dir,
          join("db", "wait.bun.sh"),
          ["# ---", "# desc: Wait for the DB", "# ---", "console.log('wait');", ""].join("\n"),
        );
        process.chdir(dir);

        const commands = await listFromLive();
        expect(commands.map((c) => c.id).sort()).toEqual(["app:composer", "app:db:wait"]);

        const cachePath = appCommandCachePath(cacheRoot, "scripted-app", dir);
        const bytes = new Uint8Array(await readFile(cachePath));
        const decoded = decodeAppCommandIndex(bytes);
        expect(decoded).not.toBeNull();
        if (decoded === null) return;
        const ids = decoded.entries.map((entry) => entry.id).sort();
        expect(ids).toEqual(["app:composer", "app:db:wait"]);
        const dbWait = decoded.entries.find((entry) => entry.id === "app:db:wait");
        expect(dbWait?.service).toBe(":host");
        expect(dbWait?.summary).toBe("Wait for the DB");
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

        const cachePath = appCommandCachePath(cacheRoot, "unnamed", dir);
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
