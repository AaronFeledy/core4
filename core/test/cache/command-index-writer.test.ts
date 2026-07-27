import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import type { PluginManifest } from "@lando/sdk/schema";

import {
  readPluginCommandCache,
  writePluginCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import { decodePluginCommandIndex } from "../../src/cache/command-index.ts";
import { pluginCommandCachePath } from "../../src/cache/paths.ts";
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
      const cachePath = await Effect.runPromise(writePluginCommandCacheStrict({ cacheRoot, now: () => 99 }));
      const decoded = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));
      const expectedNames = BUNDLED_PLUGIN_MODULES.map((module) => String(module.manifest.name));

      expect(decoded?.pluginNames).toEqual(expectedNames);
      expect(pluginCommandCachePath(cacheRoot)).toBe(cachePath);
    });
  });
});
