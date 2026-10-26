import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { finalizePluginInstall, validatePluginManifest } from "../../src/operations/plugin-install.ts";
import { recordInstalledPlugin } from "../../src/plugins/installed-registry.ts";

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
            recordInstalledPlugin: async (path, installed) => {
              await recordInstalledPlugin(path, installed);
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
