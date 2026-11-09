import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { writeFileAtomic } from "@lando/state-store/atomic";
import { finalizePluginInstall, validatePluginManifest } from "../../src/operations/plugin-install.ts";

test("reports the offending key path when a plugin manifest contains an excess key", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-manifest-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/lando-plugin-broken",
        version: "1.0.0",
        landoPlugin: { name: "@acme/lando-plugin-broken", version: "1.0.0", unsupported: true },
      }),
    );

    // When / Then
    await expect(validatePluginManifest(root)).rejects.toMatchObject({
      _tag: "PluginManifestError",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["unsupported"], message: expect.any(String) }),
      ]),
      remediation: expect.any(String),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores previous registry bytes when install recording publishes then rejects", async () => {
  // Given an existing version, registry bytes, and a staged replacement
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-install-operation-"));
  const pluginsRoot = join(root, "plugins");
  const stagedPath = join(root, "staged");
  const entry = { name: "example", version: "2.0.0", path: join(pluginsRoot, "example", "2.0.0") };
  const previousPath = join(pluginsRoot, "example", "1.0.0");
  const registryPath = join(pluginsRoot, "registry.json");
  const registry = `{ "example": { "name": "example", "version": "1.0.0", "path": ${JSON.stringify(previousPath)} } }\n`;
  try {
    await mkdir(previousPath, { recursive: true });
    await mkdir(join(pluginsRoot, "example"), { recursive: true });
    await mkdir(stagedPath);
    await writeFile(registryPath, registry);

    // When a post-publication failure rejects the registry write
    await expect(
      Effect.runPromise(
        finalizePluginInstall(
          { pluginsRoot, entry, stagedPath },
          {
            writeFileAtomic: async (path, installed) => {
              await writeFileAtomic(path, installed);
              throw new Error("directory sync failed");
            },
          },
        ),
      ),
    ).rejects.toThrow("directory sync failed");

    // Then the prior version and exact registry bytes survive without the new package
    expect(await readFile(registryPath, "utf8")).toBe(registry);
    expect((await lstat(previousPath)).isDirectory()).toBe(true);
    await expect(lstat(entry.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to install over a linked plugin with a typed error and keeps the link", async () => {
  // Given a registry entry linked from a local checkout
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-install-linked-"));
  const pluginsRoot = join(root, "plugins");
  const registryPath = join(pluginsRoot, "registry.json");
  const linked = {
    example: {
      name: "example",
      version: "0.0.0",
      path: join(pluginsRoot, "example"),
      source: "linked",
      linkedPath: join(root, "checkout"),
    },
  };
  try {
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(registryPath, `${JSON.stringify(linked, null, 2)}\n`);
    const before = await readFile(registryPath, "utf8");

    // When an install of the same name is finalized
    const failure = await Effect.runPromise(
      Effect.flip(
        finalizePluginInstall({
          pluginsRoot,
          entry: { name: "example", version: "1.0.0", path: join(pluginsRoot, "example", "1.0.0") },
        }),
      ),
    );

    // Then it fails as a tagged error that names the unlink step, and the link is untouched
    expect(failure).toMatchObject({ _tag: "NotImplementedError", commandId: "meta:plugin:add" });
    expect(failure.remediation).toContain("lando meta:plugin:unlink example");
    expect(await readFile(registryPath, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
