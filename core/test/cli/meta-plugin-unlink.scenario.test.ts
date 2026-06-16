import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";
import { pluginCommandCachePath } from "../../src/cache/paths.ts";
import { pluginLink } from "../../src/cli/commands/plugin-link.ts";
import {
  type PluginUnlinkOptions,
  pluginUnlink,
  renderPluginUnlinkResult,
} from "../../src/cli/commands/plugin-unlink.ts";

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

const lexists = async (path: string): Promise<boolean> =>
  lstat(path).then(
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
        landoPlugin: { name, version: "1.2.3", api: 4, entry: "index.js" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(pluginRoot, "index.js"), "export {};\n");
  return pluginRoot;
};

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

const runPluginLink = (options: { cwd: string; cacheRoot?: string }) =>
  Effect.runPromise(pluginLink(options).pipe(Effect.provide(fakeConfigService(userDataRoot))));

const runPluginUnlink = (options: PluginUnlinkOptions) =>
  Effect.runPromise(pluginUnlink(options).pipe(Effect.provide(fakeConfigService(userDataRoot))));

const runPluginUnlinkExit = (options: PluginUnlinkOptions) =>
  Effect.runPromiseExit(pluginUnlink(options).pipe(Effect.provide(fakeConfigService(userDataRoot))));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-plugin-unlink-"));
  userDataRoot = join(root, "data");
  cacheRoot = join(root, "cache");
});

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("meta:plugin:unlink command", () => {
  test("removes a linked symlink and registry metadata without touching the source authoring path", async () => {
    const pluginRoot = await makePluginRoot("@acme/lando-plugin-unlink", "unlink");
    const sourceSentinel = join(pluginRoot, "SOURCE_SENTINEL");
    await writeFile(sourceSentinel, "unchanged");
    await runPluginLink({ cwd: pluginRoot, cacheRoot });

    const pluginsRoot = join(userDataRoot, "plugins");
    const registryEntry = join(pluginsRoot, "@acme/lando-plugin-unlink");
    expect((await lstat(registryEntry)).isSymbolicLink()).toBe(true);

    const cachePath = pluginCommandCachePath(cacheRoot);
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(cachePath, "stale cache");

    const result = await runPluginUnlink({ name: "@acme/lando-plugin-unlink", cacheRoot });

    expect(result).toEqual({
      pluginName: "@acme/lando-plugin-unlink",
      registryEntry,
      action: "removed",
    });
    expect(renderPluginUnlinkResult(result)).toContain("result: removed");
    expect(await lexists(registryEntry)).toBe(false);
    const registry = await readJson<Record<string, unknown>>(join(pluginsRoot, "registry.json"));
    expect(registry["@acme/lando-plugin-unlink"]).toBeUndefined();
    const linkedState = await readJson<Record<string, unknown>>(join(pluginsRoot, ".lando-linked.json"));
    expect(linkedState["@acme/lando-plugin-unlink"]).toBeUndefined();
    expect(await exists(cachePath)).toBe(false);
    expect(await readFile(sourceSentinel, "utf8")).toBe("unchanged");
    expect(await readFile(join(pluginRoot, "package.json"), "utf8")).toContain("@acme/lando-plugin-unlink");
  });

  test("restores the prior registry copy atomically when the lockfile recorded one", async () => {
    const pluginRoot = await makePluginRoot("@acme/lando-plugin-restore", "restore");
    const pluginsRoot = join(userDataRoot, "plugins");
    const registryEntry = join(pluginsRoot, "@acme/lando-plugin-restore");
    const priorCopyPath = join(pluginsRoot, "@acme", "lando-plugin-restore-prior");
    await mkdir(pluginsRoot, { recursive: true });
    await mkdir(join(pluginsRoot, "@acme"), { recursive: true });
    await symlink(resolve(pluginRoot), registryEntry, "dir");
    const previousRegistry = {
      name: "@acme/lando-plugin-restore",
      version: "1.0.0",
      path: priorCopyPath,
      source: "installed" as const,
    };
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify(
        {
          "@acme/lando-plugin-restore": {
            name: "@acme/lando-plugin-restore",
            version: "1.2.3",
            path: registryEntry,
            source: "linked",
            linkedPath: resolve(pluginRoot),
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(pluginsRoot, ".lando-linked.json"),
      `${JSON.stringify(
        {
          "@acme/lando-plugin-restore": {
            source: "linked",
            linkedPath: resolve(pluginRoot),
            registryEntry,
            previousRegistry,
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await runPluginUnlink({ name: "@acme/lando-plugin-restore", cacheRoot });

    expect(result).toEqual({
      pluginName: "@acme/lando-plugin-restore",
      registryEntry,
      action: "restored",
      restoredPath: priorCopyPath,
    });
    expect(renderPluginUnlinkResult(result)).toContain("result: restored");
    expect(await lexists(registryEntry)).toBe(false);
    const registry = await readJson<Record<string, typeof previousRegistry>>(
      join(pluginsRoot, "registry.json"),
    );
    expect(registry["@acme/lando-plugin-restore"]).toEqual(previousRegistry);
    const linkedState = await readJson<Record<string, unknown>>(join(pluginsRoot, ".lando-linked.json"));
    expect(linkedState["@acme/lando-plugin-restore"]).toBeUndefined();
    expect(await readFile(join(pluginRoot, "package.json"), "utf8")).toContain("@acme/lando-plugin-restore");
  });

  test("fails when the plugin is not linked without mutating the filesystem", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");

    const exit = await runPluginUnlinkExit({ name: "@acme/lando-plugin-missing", cacheRoot });

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("PluginUnlinkNotLinkedError");
    }
    expect(await exists(pluginsRoot)).toBe(false);
    expect(await exists(pluginCommandCachePath(cacheRoot))).toBe(false);
  });

  test("refuses a name that escapes the plugins root without mutating the filesystem", async () => {
    const exit = await runPluginUnlinkExit({ name: "../escape/lando-plugin-hostile", cacheRoot });

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("outside");
    }
    expect(await exists(join(userDataRoot, "escape"))).toBe(false);
    expect(await exists(pluginCommandCachePath(cacheRoot))).toBe(false);
  });

  test("refuses to remove a real installed directory that is not a linked symlink", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const registryEntry = join(pluginsRoot, "@acme/lando-plugin-installed");
    await mkdir(registryEntry, { recursive: true });
    await writeFile(join(registryEntry, "package.json"), "{}\n");
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify(
        {
          "@acme/lando-plugin-installed": {
            name: "@acme/lando-plugin-installed",
            version: "1.0.0",
            path: registryEntry,
            source: "installed",
          },
        },
        null,
        2,
      )}\n`,
    );

    const exit = await runPluginUnlinkExit({ name: "@acme/lando-plugin-installed", cacheRoot });

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("PluginUnlinkNotLinkedError");
    }
    expect((await lstat(registryEntry)).isDirectory()).toBe(true);
    expect(await exists(join(registryEntry, "package.json"))).toBe(true);
  });
});
