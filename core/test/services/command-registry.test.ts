import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { CommandRegistry, type RegisteredCommand } from "@lando/core/services";
import { CacheError } from "@lando/sdk/errors";
import type { PluginManifest } from "@lando/sdk/schema";

import {
  invalidatePluginCommandCache,
  readAppCommandCache,
  readFreshAppCommandCacheForCwd,
  readPluginCommandCache,
  writeAppCommandCache,
  writeAppCommandCacheStrict,
  writePluginCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import {
  decodeAppCommandIndex,
  decodePluginCommandIndex,
  encodeAppCommandIndex,
  encodePluginCommandIndex,
} from "../../src/cache/command-index.ts";
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
      Effect.provide(makeLandoRuntime({ bootstrap: "tooling", plugins: { policy: "discovery" } })),
    ) as Effect.Effect<ReadonlyArray<RegisteredCommand>, never, never>,
  );

const manifest = (name: string, commands: ReadonlyArray<string>, version = "0.0.0"): PluginManifest => ({
  name: name as PluginManifest["name"],
  version,
  api: 4,
  contributes: { commands },
});

const writeInstalledPlugin = async (pluginsRoot: string, plugin: PluginManifest): Promise<void> => {
  const packageRoot = join(pluginsRoot, plugin.name, plugin.version);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: plugin.name, version: plugin.version, landoPlugin: plugin })}\n`,
  );
  await writeFile(
    join(pluginsRoot, "registry.json"),
    `${JSON.stringify({
      [plugin.name]: { name: plugin.name, version: plugin.version, path: packageRoot },
    })}\n`,
  );
};

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

  test("makeLandoRuntime({ bootstrap: 'tooling' }) writes plugin commands from discovered user plugins", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const dataRoot = await mkdtemp(join(tmpdir(), "lando-command-registry-data-"));
        const confRoot = await mkdtemp(join(tmpdir(), "lando-command-registry-conf-"));
        const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
        const previousConfRoot = process.env.LANDO_USER_CONF_ROOT;
        try {
          process.env.LANDO_USER_DATA_ROOT = dataRoot;
          process.env.LANDO_USER_CONF_ROOT = confRoot;
          await writeFile(
            join(dir, ".lando.yml"),
            ["name: plugin-cache-app", "tooling:", "  build:", "    cmd: make", ""].join("\n"),
          );
          await writeInstalledPlugin(
            join(dataRoot, "plugins"),
            manifest("@lando/plugin-extra", ["extra:doctor"], "1.2.3"),
          );
          process.chdir(dir);

          await listFromBootstrap();

          const decoded = decodePluginCommandIndex(
            new Uint8Array(await readFile(pluginCommandCachePath(cacheRoot))),
          );
          expect(decoded?.pluginNames).toContain("@lando/plugin-extra");
          expect(decoded?.commandsByPlugin?.["@lando/plugin-extra"]).toEqual(["extra:doctor"]);
        } finally {
          // biome-ignore lint/performance/noDelete: process.env delete is required for correct cleanup on Windows (Bun sets undefined as string "undefined" otherwise)
          if (previousDataRoot === undefined) delete process.env.LANDO_USER_DATA_ROOT;
          else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
          // biome-ignore lint/performance/noDelete: process.env delete is required for correct cleanup on Windows (Bun sets undefined as string "undefined" otherwise)
          if (previousConfRoot === undefined) delete process.env.LANDO_USER_CONF_ROOT;
          else process.env.LANDO_USER_CONF_ROOT = previousConfRoot;
          await rm(dataRoot, { recursive: true, force: true });
          await rm(confRoot, { recursive: true, force: true });
        }
      });
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

  test("invalidates the warm tooling cache when version-constraint provenance is missing", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const landofile = { name: "version-cache", tooling: { build: { cmd: "make" } } };
        await writeFile(
          join(dir, ".lando.yml"),
          ["name: version-cache", "tooling:", "  build:", "    cmd: make", ""].join("\n"),
        );
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile,
            entries: [{ id: "app:cached-only", summary: "from stale cache", hidden: false }],
            cwd: dir,
            cacheRoot,
            now: () => 100,
          }),
        );
        const toolingCachePath = appToolingCompilationCachePath(cacheRoot, dir);
        const decoded = decodeAppCommandIndex(new Uint8Array(await readFile(toolingCachePath)));
        if (decoded === null) throw new Error("expected app-command cache payload");
        const { versionConstraints: _discard, ...legacyPayload } = decoded as typeof decoded & {
          readonly versionConstraints?: unknown;
        };
        await writeFile(toolingCachePath, encodeAppCommandIndex(legacyPayload));
        process.chdir(dir);

        const commands = await listFromLive();

        expect(commands.map((c) => c.id)).toEqual(["app:build"]);
      });
    });
  });

  test("invalidates the warm tooling cache when a constraint source layer changes", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const landofile = { name: "version-cache", tooling: { build: { cmd: "make" } } };
        await writeFile(
          join(dir, ".lando.yml"),
          ["name: version-cache", "tooling:", "  build:", "    cmd: make", ""].join("\n"),
        );
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile,
            entries: [{ id: "app:cached-only", summary: "from stale cache", hidden: false }],
            cwd: dir,
            cacheRoot,
            now: () => 100,
          }),
        );
        await writeFile(join(dir, ".lando.base.yml"), "lando: >=99\n");

        const fresh = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: dir, cacheRoot }));

        expect(fresh).toBeNull();
      });
    });
  });

  test("does not write tooling caches while an unsatisfied version constraint is skipped", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const previousSkip = process.env.LANDO_SKIP_VERSION_CONSTRAINT;
        try {
          process.env.LANDO_SKIP_VERSION_CONSTRAINT = "1";
          await writeFile(
            join(dir, ".lando.yml"),
            ["name: skipped-version-cache", "lando: >=99", "tooling:", "  build:", "    cmd: make", ""].join(
              "\n",
            ),
          );
          process.chdir(dir);

          const commands = await listFromLive();

          expect(commands.map((c) => c.id)).toEqual(["app:build"]);
          expect(await Bun.file(appCommandCachePath(cacheRoot, "skipped-version-cache", dir)).exists()).toBe(
            false,
          );
          expect(await Bun.file(appToolingCompilationCachePath(cacheRoot, dir)).exists()).toBe(false);
        } finally {
          if (previousSkip === undefined)
            Reflect.deleteProperty(process.env, "LANDO_SKIP_VERSION_CONSTRAINT");
          else process.env.LANDO_SKIP_VERSION_CONSTRAINT = previousSkip;
        }
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

  test("invalidates the warm tooling cache when a templated local include target changes", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const previousInclude = process.env.LANDO_TEMPLATE_INCLUDE;
        try {
          process.env.LANDO_TEMPLATE_INCLUDE = "fragment-ok.yml";
          await writeFile(join(dir, "fragment-ok.yml"), "lando: >=0\n");
          await writeFile(join(dir, "fragment-bad.yml"), "lando: >=99\n");
          await writeFile(
            join(dir, ".lando.yml"),
            [
              "template: handlebars",
              "name: include-warm-cache",
              "includes:",
              "  - {{env.LANDO_TEMPLATE_INCLUDE}}",
              "tooling:",
              "  build:",
              "    cmd: make",
              "",
            ].join("\n"),
          );
          process.chdir(dir);

          const cold = await listFromLive();
          expect(cold.map((c) => c.id)).toEqual(["app:build"]);

          const fresh = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: dir, cacheRoot }));
          expect(fresh).toBeNull();

          process.env.LANDO_TEMPLATE_INCLUDE = "fragment-bad.yml";
          const stale = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: dir, cacheRoot }));

          expect(stale).toBeNull();

          const commands = await listFromLive();

          expect(commands).toEqual([]);
        } finally {
          if (previousInclude === undefined) Reflect.deleteProperty(process.env, "LANDO_TEMPLATE_INCLUDE");
          else process.env.LANDO_TEMPLATE_INCLUDE = previousInclude;
        }
      });
    });
  });

  test("reads unchanged cached constraints without reparsing the Landofile", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        await writeFile(join(dir, ".lando.yml"), "name: cached\nlando: not-semver\n");
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile: { name: "cached", lando: ">=0", tooling: { build: { cmd: "make" } } },
            entries: [{ id: "app:build", summary: "", hidden: false }],
            cwd: dir,
            cacheRoot,
          }),
        );

        const cached = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: dir, cacheRoot }));

        expect(cached?.entries.map((entry) => entry.id)).toEqual(["app:build"]);
      });
    });
  });

  test("invalidates the warm tooling cache when a BOM-prefixed Landofile is templated", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withTempCwd(async (dir) => {
        const landofile = { name: "bom-template-cache", tooling: { build: { cmd: "make" } } };
        await writeFile(
          join(dir, ".lando.yml"),
          [
            "\uFEFFtemplate: none",
            "name: bom-template-cache",
            "tooling:",
            "  build:",
            "    cmd: make",
            "",
          ].join("\n"),
        );
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile,
            entries: [{ id: "app:cached-only", summary: "from stale cache", hidden: false }],
            cwd: dir,
            cacheRoot,
            now: () => 100,
          }),
        );

        const fresh = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: dir, cacheRoot }));

        expect(fresh).toBeNull();
      });
    });
  });

  test("does not use cached tooling when a local include symlink escapes the app root", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "lando-command-registry-outside-"));
    try {
      await withTempCacheRoot(async (cacheRoot) => {
        await withTempCwd(async (dir) => {
          const landofile = {
            name: "symlink-include-cache",
            includes: ["fragment.yml"],
            tooling: { build: { cmd: "make" } },
          };
          await writeFile(
            join(dir, ".lando.yml"),
            [
              "name: symlink-include-cache",
              "includes:",
              "  - fragment.yml",
              "tooling:",
              "  build:",
              "    cmd: make",
              "",
            ].join("\n"),
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
          const outsideFragment = join(outsideRoot, "fragment.yml");
          await writeFile(outsideFragment, "lando: >=0\n");
          await symlink(outsideFragment, join(dir, "fragment.yml"));
          process.chdir(dir);

          const commands = await listFromLive();

          expect(commands).toEqual([]);
        });
      });
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
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
        await writeFile(join(dir, "fragment.yml"), "lando: >=0\n");
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
        expect(decoded.schemaVersion).toBe(2);
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

  test("writes plugin-list SHA and per-plugin command ids into the plugin-command cache", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const manifests = [
        manifest("@lando/a", ["a:one", "a:two"], "1.0.0"),
        manifest("@lando/b", []),
      ] as const;

      const cachePath = await Effect.runPromise(
        writePluginCommandCacheStrict({ manifests, cacheRoot, now: () => 100 }),
      );
      const decoded = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));

      expect(decoded?.pluginNames).toEqual(["@lando/a", "@lando/b"]);
      expect(decoded?.pluginListSha).toMatch(/^[a-f0-9]{64}$/u);
      expect(decoded?.commandsByPlugin).toEqual({
        "@lando/a": ["a:one", "a:two"],
        "@lando/b": [],
      });
    });
  });

  test("rewrites an old plugin-command cache that lacks plugin-list metadata", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const manifests = [manifest("@lando/a", ["a:one"])] as const;
      const cachePath = await Effect.runPromise(
        writePluginCommandCacheStrict({ manifests, cacheRoot, now: () => 100 }),
      );
      const oldPayload = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));
      expect(oldPayload?.manifestFingerprint).toBeString();
      if (oldPayload?.manifestFingerprint === undefined) throw new Error("expected manifest fingerprint");
      await writeFile(
        cachePath,
        encodePluginCommandIndex({
          schemaVersion: 1,
          landoVersion: oldPayload.landoVersion,
          pluginNames: ["@lando/a"],
          manifestFingerprint: oldPayload.manifestFingerprint,
          generatedAtMs: 100,
          entries: [{ id: "a:one", summary: "", hidden: false }],
        }),
      );

      await Effect.runPromise(writePluginCommandCacheStrict({ manifests, cacheRoot, now: () => 200 }));
      const rewritten = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));

      expect(rewritten?.generatedAtMs).toBe(200);
      expect(rewritten?.pluginListSha).toMatch(/^[a-f0-9]{64}$/u);
      expect(rewritten?.commandsByPlugin).toEqual({ "@lando/a": ["a:one"] });
    });
  });

  test("invalidates the plugin-command cache by removing the cache file", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const cachePath = await Effect.runPromise(
        writePluginCommandCacheStrict({ manifests: [manifest("@lando/a", ["a:one"])], cacheRoot }),
      );

      await Effect.runPromise(invalidatePluginCommandCache({ cacheRoot }));

      let readFailure: unknown;
      try {
        await readFile(cachePath);
      } catch (cause) {
        readFailure = cause;
      }
      expect(readFailure).toMatchObject({ code: "ENOENT" });
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
