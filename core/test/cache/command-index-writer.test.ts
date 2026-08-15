import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { type PluginManifest, ServiceName } from "@lando/sdk/schema";

import {
  decodePluginCommandIndex,
  deriveAppCommandToolingFingerprint,
} from "@lando/engine/cache/command-index";
import {
  invalidatePluginCommandCache,
  readFreshAppCommandCacheForCwd,
  readPluginCommandCache,
  writeAppCommandCacheStrict,
  writePluginCommandCacheStrict,
} from "@lando/engine/cache/command-index-writer";
import { appToolingCompilationCachePath, pluginCommandCachePath } from "@lando/engine/cache/paths";
import { mergeDiscoveredPlugins } from "@lando/engine/plugins/plugin-discovery";
import { rememberLandofileReferencedFiles } from "@lando/landofile/load-expression-provenance";
import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";

const manifest = (name: string, commands: ReadonlyArray<string>, version = "0.0.0"): PluginManifest => ({
  name: name as PluginManifest["name"],
  version,
  api: 4,
  bootstrap: "app",
  contributes: { commands },
});

const fakeModule = (name: string, commands: ReadonlyArray<string>) => ({
  name,
  manifest: manifest(name, commands),
});

const withTempCacheRoot = async <T>(run: (cacheRoot: string) => Promise<T>): Promise<T> => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-command-index-writer-"));
  try {
    return await run(cacheRoot);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

describe("writePluginCommandCacheStrict modules default", () => {
  test("derives manifests from injected modules when manifests is omitted", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const modules = [
        fakeModule("@lando/fake-a", ["fake:a"]),
        fakeModule("@lando/fake-b", ["fake:b1", "fake:b2"]),
      ] as const;

      const cachePath = await Effect.runPromise(
        writePluginCommandCacheStrict({ modules, cacheRoot, now: () => 42 }),
      );
      const decoded = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));

      expect(decoded?.pluginNames).toEqual(["@lando/fake-a", "@lando/fake-b"]);
      expect(decoded?.commandsByPlugin).toEqual({
        "@lando/fake-a": ["fake:a"],
        "@lando/fake-b": ["fake:b1", "fake:b2"],
      });
      expect(decoded?.entries.map((entry) => entry.id).sort()).toEqual(["fake:a", "fake:b1", "fake:b2"]);
      expect(decoded?.generatedAtMs).toBe(42);
    });
  });

  test("prefers explicit manifests over modules", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const modules = [fakeModule("@lando/from-module", ["module:cmd"])] as const;
      const manifests = [manifest("@lando/from-manifests", ["manifest:cmd"])] as const;

      const cachePath = await Effect.runPromise(
        writePluginCommandCacheStrict({ modules, manifests, cacheRoot, now: () => 7 }),
      );
      const decoded = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));

      expect(decoded?.pluginNames).toEqual(["@lando/from-manifests"]);
      expect(decoded?.entries.map((entry) => entry.id)).toEqual(["manifest:cmd"]);
    });
  });

  test("regenerates the cache when manifest order changes on the same cache root", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const first = manifest("@lando/first", ["first:command"]);
      const second = manifest("@lando/second", ["second:command"]);
      await Effect.runPromise(
        writePluginCommandCacheStrict({ manifests: [first, second], cacheRoot, now: () => 1 }),
      );

      // When
      const cachePath = await Effect.runPromise(
        writePluginCommandCacheStrict({ manifests: [second, first], cacheRoot, now: () => 2 }),
      );
      const decoded = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));

      // Then
      expect(decoded?.pluginNames).toEqual(["@lando/second", "@lando/first"]);
      expect(decoded?.generatedAtMs).toBe(2);
    });
  });

  test("uses explicit precedence for the same plugin name across every implemented source", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const bundled = manifest("@lando/same-name", ["bundled:command"]);
      const system = manifest("@lando/same-name", ["system:command"]);
      const user = manifest("@lando/same-name", ["user:command"]);
      const app = manifest("@lando/same-name", ["app:command"]);
      const explicit = manifest("@lando/same-name", ["explicit:command"]);
      const plugins = await Effect.runPromise(
        mergeDiscoveredPlugins(
          [
            [{ source: "bundled", manifest: bundled }],
            [{ source: "system", manifest: system }],
            [{ source: "user", manifest: user }],
            [{ source: "app", manifest: app }],
            [{ source: "explicit", manifest: explicit }],
          ],
          undefined,
        ),
      );

      // When
      const cachePath = await Effect.runPromise(
        writePluginCommandCacheStrict({
          manifests: plugins.map((plugin) => plugin.manifest),
          cacheRoot,
        }),
      );
      const decoded = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));

      // Then
      expect(decoded?.commandsByPlugin).toEqual({ "@lando/same-name": ["explicit:command"] });
      expect(decoded?.entries.map((entry) => entry.id)).toEqual(["explicit:command"]);
    });
  });

  test("keeps the first cross-plugin command id and sorts the compiled index", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const manifests = [
        manifest("@lando/first", ["shared:command", "z:last"]),
        manifest("@lando/second", ["a:first", "shared:command"]),
      ];

      // When
      const cachePath = await Effect.runPromise(writePluginCommandCacheStrict({ manifests, cacheRoot }));
      const decoded = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));

      // Then
      expect(decoded?.entries.map((entry) => entry.id)).toEqual(["a:first", "shared:command", "z:last"]);
      expect(decoded?.entries.filter((entry) => entry.id === "shared:command")).toHaveLength(1);
    });
  });

  test("readPluginCommandCache uses the same modules default for freshness checks", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const modules = [fakeModule("@lando/read-default", ["read:cmd"])] as const;

      await Effect.runPromise(writePluginCommandCacheStrict({ modules, cacheRoot, now: () => 1 }));
      const fresh = await Effect.runPromise(readPluginCommandCache({ modules, cacheRoot }));
      expect(fresh?.entries.map((entry) => entry.id)).toEqual(["read:cmd"]);

      const stale = await Effect.runPromise(
        readPluginCommandCache({
          modules: [fakeModule("@lando/read-default", ["read:other"])],
          cacheRoot,
        }),
      );
      expect(stale).toBeNull();
    });
  });

  test("defaults to BUNDLED_PLUGIN_MODULES manifests when neither manifests nor modules is set", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const expectedNames = BUNDLED_PLUGIN_MODULES.map((module) => String(module.manifest.name));

      // When
      const cachePath = await Effect.runPromise(writePluginCommandCacheStrict({ cacheRoot, now: () => 99 }));
      const decoded = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));
      const fresh = await Effect.runPromise(readPluginCommandCache({ cacheRoot }));

      // Then
      expect(decoded?.pluginNames).toEqual(expectedNames);
      expect(fresh?.pluginNames).toEqual(expectedNames);
      expect(pluginCommandCachePath(cacheRoot)).toBe(cachePath);
    });
  });

  test("invalidation removes the plugin-command cache", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const modules = [fakeModule("@lando/invalidate", ["invalidate:command"])] as const;
      await Effect.runPromise(writePluginCommandCacheStrict({ modules, cacheRoot }));

      // When
      await Effect.runPromise(invalidatePluginCommandCache({ cacheRoot }));

      // Then
      expect(await Effect.runPromise(readPluginCommandCache({ modules, cacheRoot }))).toBeNull();
    });
  });

  test("invalidation also removes service-derived app tooling caches", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = join(cacheRoot, "service-app");
      await mkdir(appRoot, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: service-app\nservices:\n  app:\n    type: node\n");
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile: {
            name: "service-app",
            services: { [ServiceName.make("app")]: { type: "node" } },
          },
          entries: [{ id: "app:node", summary: "Node tooling", hidden: false, service: "app" }],
          cwd: appRoot,
          cacheRoot,
        }),
      );
      expect(
        await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot })),
      ).not.toBeNull();

      // When
      await Effect.runPromise(invalidatePluginCommandCache({ cacheRoot }));

      // Then
      expect(await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }))).toBeNull();
    });
  });
});

describe("writeAppCommandCacheStrict command alias policy", () => {
  test("invalidates cached aliases when a referenced file changes", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = join(cacheRoot, "referenced-alias-app");
      const targetPath = join(appRoot, "alias-target.txt");
      const initialTarget = "app:known";
      await mkdir(appRoot, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: referenced-alias-app\n");
      await writeFile(targetPath, initialTarget);
      const targetStats = await stat(targetPath);
      const landofile = rememberLandofileReferencedFiles(
        { name: "referenced-alias-app", commandAliases: { custom: { hi: initialTarget } } },
        [
          {
            absolutePath: targetPath,
            mtimeMs: targetStats.mtimeMs,
            size: targetStats.size,
            sha256: createHash("sha256").update(initialTarget).digest("hex"),
          },
        ],
      );
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile,
          entries: [{ id: "app:known", summary: "Known task", hidden: false }],
          cwd: appRoot,
          cacheRoot,
        }),
      );
      expect(
        await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot })),
      ).not.toBeNull();

      // When
      await writeFile(targetPath, "app:other");

      // Then
      expect(await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }))).toBeNull();
    });
  });

  test("persists a normalized policy on a fresh app command cache", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = join(cacheRoot, "alias-app");
      await mkdir(appRoot, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: alias-app\n");
      const landofile = {
        name: "alias-app",
        commandAliases: {
          disabled: ["stop", "stop"],
          custom: { zed: "app:known", hi: "app:known" },
        },
      };

      // When
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile,
          entries: [{ id: "app:known", summary: "Known task", hidden: false }],
          cwd: appRoot,
          cacheRoot,
        }),
      );
      const payload = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));

      // Then
      expect(payload?.aliasPolicy).toEqual({
        enabled: true,
        disabled: ["stop"],
        custom: { hi: "app:known", zed: "app:known" },
      });
    });
  });

  test("refreshes alias policy when reusing an otherwise fresh command cache", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = join(cacheRoot, "alias-reuse-app");
      await mkdir(appRoot, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: alias-reuse-app\n");
      const landofile = {
        name: "alias-reuse-app",
        commandAliases: { enabled: false, custom: { hi: "app:known" } },
      };
      const entries = [{ id: "app:known", summary: "Known task", hidden: false }] as const;
      await Effect.runPromise(
        writeAppCommandCacheStrict({ landofile, entries, cwd: appRoot, cacheRoot, now: () => 41 }),
      );
      await rm(appToolingCompilationCachePath(cacheRoot, appRoot));

      // When
      await Effect.runPromise(
        writeAppCommandCacheStrict({ landofile, entries, cwd: appRoot, cacheRoot, now: () => 99 }),
      );
      const payload = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));

      // Then
      expect(payload?.generatedAtMs).toBe(41);
      expect(payload?.aliasPolicy).toEqual({
        enabled: false,
        disabled: [],
        custom: { hi: "app:known" },
      });
    });
  });

  test("includes command aliases in the semantic tooling fingerprint", () => {
    // Given
    const base = { name: "alias-fingerprint" };

    // When
    const withoutAliases = deriveAppCommandToolingFingerprint(base);
    const withAliases = deriveAppCommandToolingFingerprint({
      ...base,
      commandAliases: { custom: { hi: "app:known" } },
    });

    // Then
    expect(withAliases).not.toBe(withoutAliases);
  });

  test("omits alias policy when the Landofile has no commandAliases section", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = join(cacheRoot, "no-alias-app");
      await mkdir(appRoot, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: no-alias-app\n");

      // When
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile: { name: "no-alias-app" },
          entries: [],
          cwd: appRoot,
          cacheRoot,
        }),
      );
      const payload = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));

      // Then
      expect(payload).not.toHaveProperty("aliasPolicy");
    });
  });
});
