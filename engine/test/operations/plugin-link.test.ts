import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPluginLink } from "../../src/operations/plugin-link.ts";
import { replaceInstalledPluginRegistry } from "../../src/plugins/installed-registry.ts";
import { readLinkedState, writeLinkedState } from "../../src/plugins/linked-state.ts";

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
const statePath = () => join(pluginsRoot, ".lando-linked.json");
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

describe("applyPluginLink rollback", () => {
  test("restores linked state and previous registry bytes when registry publication fails", async () => {
    // Given unrelated metadata that must survive a failed link
    const registry = '{ "existing": { "name": "existing", "version": "1.0.0", "path": "/existing" } }\n';
    await writeFile(registryPath(), registry);
    await writeLinkedState(pluginsRoot, {});
    const state = await readFile(statePath(), "utf8");
    // When registry recording fails after linked state is written
    await expect(
      applyPluginLink(input(), {
        writeLinkedState,
        replaceInstalledPluginRegistry: rejectWrite,
      }),
    ).rejects.toBe(failure);
    // Then no new link survives and prior metadata is restored
    await expect(lstat(entryPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(statePath(), "utf8")).toBe(state);
    expect(await readFile(registryPath(), "utf8")).toBe(registry);
  });

  test("preserves corrupt registry bytes when linked-state publication fails", async () => {
    // Given a corrupt registry and a writer that fails before publishing
    const registry = "not-json\n";
    await writeFile(registryPath(), registry);
    // When the linked-state writer rejects
    await expect(
      applyPluginLink(input(), {
        writeLinkedState: rejectWrite,
        replaceInstalledPluginRegistry,
      }),
    ).rejects.toBe(failure);
    // Then the symlink is removed and registry bytes are untouched
    await expect(lstat(entryPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(registryPath(), "utf8")).toBe(registry);
  });

  test("restores the original target and metadata when relink registry publication fails", async () => {
    // Given a previously linked plugin and a distinct replacement target
    await applyPluginLink(input());
    const state = await readFile(statePath(), "utf8");
    const registry = await readFile(registryPath(), "utf8");
    const replacement = join(root, "replacement");
    await mkdir(replacement);
    // When relinking fails at registry recording
    await expect(
      applyPluginLink(
        { ...input(), linkedPath: replacement },
        {
          writeLinkedState,
          replaceInstalledPluginRegistry: rejectWrite,
        },
      ),
    ).rejects.toBe(failure);
    // Then the original target and metadata remain
    expect(await readlink(entryPath())).toBe(linkedPath);
    expect(await readFile(statePath(), "utf8")).toBe(state);
    expect(await readFile(registryPath(), "utf8")).toBe(registry);
  });

  test("allows retry after a rolled-back registry failure", async () => {
    // Given an earlier failed link with no prior registry
    await expect(
      applyPluginLink(input(), {
        writeLinkedState,
        replaceInstalledPluginRegistry: rejectWrite,
      }),
    ).rejects.toBe(failure);
    await expect(lstat(registryPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readLinkedState(pluginsRoot)).toEqual({});
    // When the same request is retried with working IO
    const result = await applyPluginLink(input());
    // Then the retry establishes the requested link
    expect(result.registryEntry).toBe(entryPath());
    expect((await lstat(entryPath())).isSymbolicLink()).toBe(true);
    expect(await readlink(entryPath())).toBe(linkedPath);
  });

  test("restores prior state when its writer publishes and then rejects", async () => {
    // Given prior state and registry bytes
    await writeLinkedState(pluginsRoot, {});
    const state = await readFile(statePath(), "utf8");
    const registry = "{}\n";
    await writeFile(registryPath(), registry);
    // When the linked-state writer rejects after publication, like a directory sync failure
    await expect(
      applyPluginLink(input(), {
        writeLinkedState: async (path, value) => {
          await writeLinkedState(path, value);
          throw failure;
        },
        replaceInstalledPluginRegistry,
      }),
    ).rejects.toBe(failure);
    // Then rollback restores prior bytes and removes the newly published symlink
    expect(await readFile(statePath(), "utf8")).toBe(state);
    expect(await readFile(registryPath(), "utf8")).toBe(registry);
    await expect(lstat(entryPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});
