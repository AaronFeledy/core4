import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginManifestError } from "@lando/sdk/errors";
import { loadInstalledPluginManifest } from "../../src/plugins/installed-plugin-loader.ts";

const descriptor = {
  id: "installed-sync",
  supports: { platform: ["linux"] },
  capabilities: {
    modes: ["two-way-safe"],
    remoteAgentDeployment: "none",
    exclusionPatterns: true,
    progressReporting: false,
    conflictReporting: false,
  },
};

test("normalizes an installed file-sync module within its package", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-sync-installed-"));
  try {
    await writeFile(join(root, "engine.ts"), "export const engine = {};\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@test/installed-sync",
        version: "1.0.0",
        api: 4,
        contributes: { fileSyncEngines: [{ ...descriptor, module: "./engine.ts" }] },
      }),
    );
    const manifest = await loadInstalledPluginManifest(root);
    expect(manifest.contributes?.fileSyncEngines?.[0]?.module).toBe(
      pathToFileURL(join(root, "engine.ts")).href,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an installed file-sync module that escapes its package", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-sync-installed-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@test/installed-sync",
        version: "1.0.0",
        api: 4,
        contributes: { fileSyncEngines: [{ ...descriptor, module: "../outside.ts" }] },
      }),
    );
    await expect(loadInstalledPluginManifest(root)).rejects.toBeInstanceOf(PluginManifestError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
