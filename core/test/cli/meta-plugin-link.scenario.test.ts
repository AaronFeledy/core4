import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";
import { pluginCommandCachePath } from "../../src/cache/paths.ts";
import {
  type PluginLinkOptions,
  pluginLink,
  renderPluginLinkResult,
} from "../../src/cli/commands/plugin-link.ts";

let root: string;
let userDataRoot: string;
let cacheRoot: string;

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const makePluginRoot = async (name: string, dir = name.split("/").pop() ?? "plugin"): Promise<string> => {
  const pluginRoot = join(root, dir);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "1.2.3",
        type: "module",
        landoPlugin: {
          name,
          version: "1.2.3",
          api: 4,
          entry: "index.js",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(pluginRoot, "index.js"), "export {};\n");
  return pluginRoot;
};

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

const runPluginLink = (options: PluginLinkOptions) =>
  Effect.runPromise(pluginLink(options).pipe(Effect.provide(fakeConfigService(userDataRoot))));

const runPluginLinkExit = (options: PluginLinkOptions) =>
  Effect.runPromiseExit(pluginLink(options).pipe(Effect.provide(fakeConfigService(userDataRoot))));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-plugin-link-"));
  userDataRoot = join(root, "data");
  cacheRoot = join(root, "cache");
});

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("meta:plugin:link command", () => {
  test("defaults to cwd, symlinks the plugin, records linked registry state, and invalidates plugin command cache", async () => {
    const pluginRoot = await makePluginRoot("@acme/lando-plugin-linked", "linked");
    await mkdir(cacheRoot, { recursive: true });
    const cachePath = pluginCommandCachePath(cacheRoot);
    await writeFile(cachePath, "stale cache");

    const result = await runPluginLink({ cwd: pluginRoot, cacheRoot });

    expect(result).toEqual({
      pluginName: "@acme/lando-plugin-linked",
      linkedPath: resolve(pluginRoot),
      registryEntry: join(userDataRoot, "plugins", "@acme/lando-plugin-linked"),
    });
    expect(renderPluginLinkResult(result)).toContain("plugin-link: @acme/lando-plugin-linked");
    const registryEntry = join(userDataRoot, "plugins", "@acme/lando-plugin-linked");
    expect((await lstat(registryEntry)).isSymbolicLink()).toBe(true);
    expect(await readlink(registryEntry)).toBe(resolve(pluginRoot));

    const registry = await readJson<
      Record<
        string,
        {
          readonly path: string;
          readonly version: string;
          readonly source: string;
          readonly linkedPath: string;
        }
      >
    >(join(userDataRoot, "plugins", "registry.json"));
    expect(registry["@acme/lando-plugin-linked"]).toEqual({
      name: "@acme/lando-plugin-linked",
      version: "1.2.3",
      path: registryEntry,
      source: "linked",
      linkedPath: resolve(pluginRoot),
    });
    const linkedState = await readJson<
      Record<string, { readonly source: string; readonly linkedPath: string; readonly registryEntry: string }>
    >(join(userDataRoot, "plugins", ".lando-linked.json"));
    expect(linkedState["@acme/lando-plugin-linked"]).toEqual({
      source: "linked",
      linkedPath: resolve(pluginRoot),
      registryEntry,
    });
    expect(await exists(cachePath)).toBe(false);
  });

  test("resolves an explicit relative path before tracking the link", async () => {
    const pluginRoot = await makePluginRoot("lando-plugin-relative", "relative-plugin");

    const result = await runPluginLink({ cwd: root, path: "relative-plugin" });

    expect(result.linkedPath).toBe(resolve(pluginRoot));
    const registry = await readJson<Record<string, { readonly linkedPath: string }>>(
      join(userDataRoot, "plugins", "registry.json"),
    );
    expect(registry["lando-plugin-relative"].linkedPath).toBe(resolve(pluginRoot));
  });

  test("refuses to replace an existing non-linked registry entry without touching the source tree", async () => {
    const pluginRoot = await makePluginRoot("@acme/lando-plugin-conflict", "conflict");
    const sourceSentinel = join(pluginRoot, "SOURCE_SENTINEL");
    await writeFile(sourceSentinel, "unchanged");
    const pluginsRoot = join(userDataRoot, "plugins");
    const existing = join(pluginsRoot, "@acme", "lando-plugin-conflict", "1.0.0");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "package.json"), "{}\n");
    await mkdir(dirname(join(pluginsRoot, "registry.json")), { recursive: true });
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify(
        {
          "@acme/lando-plugin-conflict": {
            name: "@acme/lando-plugin-conflict",
            version: "1.0.0",
            path: existing,
          },
        },
        null,
        2,
      )}\n`,
    );

    const exit = await runPluginLinkExit({ cwd: pluginRoot, cacheRoot });

    expect(exit._tag).toBe("Failure");
    expect(await readFile(sourceSentinel, "utf8")).toBe("unchanged");
    expect((await lstat(existing)).isDirectory()).toBe(true);
    expect(await exists(pluginCommandCachePath(cacheRoot))).toBe(false);
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("PluginLinkConflictError");
      expect(cause).toContain("already exists");
    }
  });

  test("refuses a manifest name that escapes the plugins root without mutating the filesystem", async () => {
    const pluginRoot = await makePluginRoot("../escape/lando-plugin-hostile", "hostile");
    const pluginsRoot = join(userDataRoot, "plugins");

    const exit = await runPluginLinkExit({ cwd: pluginRoot, cacheRoot });

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("PluginManifestError");
      expect(cause).toContain("outside");
    }
    expect(await exists(pluginsRoot)).toBe(false);
    expect(await exists(join(userDataRoot, "escape"))).toBe(false);
    expect(await exists(pluginCommandCachePath(cacheRoot))).toBe(false);
  });

  test("rejects a manifest name that targets a managed plugins-root file", async () => {
    const pluginRoot = await makePluginRoot("registry.json", "managed-name");
    const pluginsRoot = join(userDataRoot, "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(join(pluginsRoot, "registry.json"), "{}\n");

    const exit = await runPluginLinkExit({ cwd: pluginRoot, cacheRoot });

    expect(exit._tag).toBe("Failure");
    expect(await readFile(join(pluginsRoot, "registry.json"), "utf8")).toBe("{}\n");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("PluginManifestError");
      expect(cause).toContain("reserved plugins root entry registry.json");
    }
    expect(await exists(pluginCommandCachePath(cacheRoot))).toBe(false);
  });

  test("removes the registry symlink when metadata recording fails so a retry can relink", async () => {
    const pluginRoot = await makePluginRoot("@acme/lando-plugin-retry", "retry");
    const pluginsRoot = join(userDataRoot, "plugins");
    const registryEntry = join(pluginsRoot, "@acme/lando-plugin-retry");
    const registryTmpPath = join(pluginsRoot, "registry.json.tmp");
    await mkdir(registryTmpPath, { recursive: true });

    const failed = await runPluginLinkExit({ cwd: pluginRoot, cacheRoot });

    expect(failed._tag).toBe("Failure");
    expect(await exists(registryEntry)).toBe(false);
    expect(await exists(join(pluginsRoot, "registry.json"))).toBe(false);

    await rm(registryTmpPath, { recursive: true, force: true });
    const result = await runPluginLink({ cwd: pluginRoot, cacheRoot });

    expect(result.registryEntry).toBe(registryEntry);
    expect((await lstat(registryEntry)).isSymbolicLink()).toBe(true);
  });
});
