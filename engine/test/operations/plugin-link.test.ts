import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "@lando/state-store/atomic";
import { applyPluginLink, revertPluginLink } from "../../src/operations/plugin-link.ts";
import { readInstalledPluginRegistry, recordInstalledPlugin } from "../../src/plugins/installed-registry.ts";

let root: string;
let pluginsRoot: string;
let linkedPath: string;
const pluginName = "@acme/lando-plugin-linked";
const failure = new Error("injected metadata failure");
const rejectWrite = async (): Promise<void> => {
  throw failure;
};
const input = () => ({ pluginsRoot, linkedPath, pluginName, version: "1.2.3" });
const registryPath = () => join(pluginsRoot, "registry.json");
const entryPath = () => join(pluginsRoot, pluginName);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-plugin-link-operation-"));
  pluginsRoot = join(root, "plugins");
  linkedPath = join(root, "source");
  await mkdir(pluginsRoot);
  await mkdir(linkedPath);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("unlink preserves a registry inspection failure instead of reporting a missing link", async () => {
  await writeFile(
    registryPath(),
    JSON.stringify({
      [pluginName]: { name: pluginName, version: "1", path: entryPath(), source: "linked", linkedPath },
    }),
  );
  const scope = join(pluginsRoot, "@acme");
  await symlink(scope, scope);
  await expect(revertPluginLink({ pluginsRoot, name: pluginName })).rejects.toMatchObject({ code: "ELOOP" });
});

describe("applyPluginLink rollback", () => {
  test("restores previous registry bytes when registry publication fails", async () => {
    // Given unrelated metadata that must survive a failed link
    const registry = '{ "existing": { "name": "existing", "version": "1.0.0", "path": "/existing" } }\n';
    await writeFile(registryPath(), registry);
    // When registry recording fails after the symlink is created
    await expect(
      applyPluginLink(input(), {
        writeFileAtomic: rejectWrite,
      }),
    ).rejects.toBe(failure);
    // Then no new link survives and prior metadata is restored
    await expect(lstat(entryPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(registryPath(), "utf8")).toBe(registry);
  });

  test("refuses corrupt registry bytes before publication", async () => {
    // Given a corrupt registry and a writer that fails before publishing
    const registry = "not-json\n";
    await writeFile(registryPath(), registry);
    // When linking inspects the corrupt registry
    await expect(
      applyPluginLink(input(), {
        writeFileAtomic: rejectWrite,
      }),
    ).rejects.toThrow("registry is corrupt");
    // Then the symlink is removed and registry bytes are untouched
    await expect(lstat(entryPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(registryPath(), "utf8")).toBe(registry);
  });

  test("restores the original target and metadata when relink registry publication fails", async () => {
    // Given a previously linked plugin and a distinct replacement target
    await applyPluginLink(input());
    const registry = await readFile(registryPath(), "utf8");
    const replacement = join(root, "replacement");
    await mkdir(replacement);
    // When relinking fails at registry recording
    await expect(
      applyPluginLink(
        { ...input(), linkedPath: replacement },
        {
          writeFileAtomic: rejectWrite,
        },
      ),
    ).rejects.toBe(failure);
    // Then the original target and metadata remain
    expect(await readlink(entryPath())).toBe(linkedPath);
    expect(await readFile(registryPath(), "utf8")).toBe(registry);
  });

  test("allows retry after a rolled-back registry failure", async () => {
    // Given an earlier failed link with no prior registry
    await expect(
      applyPluginLink(input(), {
        writeFileAtomic: rejectWrite,
      }),
    ).rejects.toBe(failure);
    await expect(lstat(registryPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readInstalledPluginRegistry(pluginsRoot)).toEqual({});
    // When the same request is retried with working IO
    const result = await applyPluginLink(input());
    // Then the retry establishes the requested link
    expect(result.registryEntry).toBe(entryPath());
    expect((await lstat(entryPath())).isSymbolicLink()).toBe(true);
    expect(await readlink(entryPath())).toBe(linkedPath);
  });

  test("restores prior state when its writer publishes and then rejects", async () => {
    // Given prior state and registry bytes
    const registry = "{}\n";
    await writeFile(registryPath(), registry);
    // When the registry writer rejects after publication, like a directory sync failure
    await expect(
      applyPluginLink(input(), {
        writeFileAtomic: async (path, value) => {
          await writeFileAtomic(path, value);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    // Then rollback restores prior bytes and removes the newly published symlink
    expect(await readFile(registryPath(), "utf8")).toBe(registry);
    await expect(lstat(entryPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("link and unlink round trip retains the source and removes the registry claim", async () => {
  await applyPluginLink(input());
  expect((await readInstalledPluginRegistry(pluginsRoot))[pluginName]?.source).toBe("linked");
  expect(await revertPluginLink({ pluginsRoot, name: pluginName })).toEqual({
    action: "removed",
    registryEntry: entryPath(),
  });
  expect(await readInstalledPluginRegistry(pluginsRoot)).toEqual({});
  await expect(lstat(entryPath())).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(linkedPath)).isDirectory()).toBe(true);
});

test("unlink tolerates a missing symlink when the registry owns the claim", async () => {
  await applyPluginLink(input());
  await rm(entryPath());
  await revertPluginLink({ pluginsRoot, name: pluginName });
  expect(await readInstalledPluginRegistry(pluginsRoot)).toEqual({});
});

test("unlink refuses an unregistered symlink", async () => {
  await mkdir(join(pluginsRoot, "@acme"));
  await symlink(linkedPath, entryPath());
  await expect(revertPluginLink({ pluginsRoot, name: pluginName })).rejects.toMatchObject({
    code: "PLUGIN_UNLINK_NOT_LINKED",
  });
  expect(await readlink(entryPath())).toBe(linkedPath);
});

test("unlink restores the symlink and registry if publication fails after rename", async () => {
  await applyPluginLink(input());
  const registry = await readFile(registryPath(), "utf8");
  await expect(
    revertPluginLink(
      { pluginsRoot, name: pluginName },
      {
        writeFileAtomic: async (path, value) => {
          await writeFileAtomic(path, value);
          throw failure;
        },
      },
    ),
  ).rejects.toBe(failure);
  expect(await readlink(entryPath())).toBe(linkedPath);
  expect(await readFile(registryPath(), "utf8")).toBe(registry);
});

test("relink restores a dangling symlink when registry publication fails", async () => {
  await applyPluginLink(input());
  await rm(linkedPath, { recursive: true });
  await expect(
    applyPluginLink({ ...input(), linkedPath: join(root, "replacement") }, { writeFileAtomic: rejectWrite }),
  ).rejects.toBe(failure);
  expect(await readlink(entryPath())).toBe(linkedPath);
});

test("install refuses a linked claim without replacing its record", async () => {
  await applyPluginLink(input());
  await expect(
    recordInstalledPlugin(pluginsRoot, { name: pluginName, version: "2", path: "/installed" }),
  ).rejects.toMatchObject({ code: "PLUGIN_LINK_CONFLICT" });
  expect((await readInstalledPluginRegistry(pluginsRoot))[pluginName]?.linkedPath).toBe(linkedPath);
});
