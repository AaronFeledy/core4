import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadInstalledPlugin } from "../../src/plugins/installed-plugin-loader";

test("concurrent app discovery keeps the first imported bytes and source revision together", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-app-plugin-race-"));
  const packageRoot = join(root, "plugin");
  const startedKey = `landoPluginStarted${crypto.randomUUID().replaceAll("-", "")}`;
  const gateKey = `landoPluginGate${crypto.randomUUID().replaceAll("-", "")}`;
  let release: () => void = () => {};
  let signalStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const globals = globalThis as Record<string, unknown>;
  globals[startedKey] = signalStarted;
  globals[gateKey] = gate;
  try {
    await mkdir(packageRoot);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/race",
        version: "1.0.0",
        landoPlugin: { name: "@example/race", version: "1.0.0", api: 4, entry: "./entry.mjs" },
      }),
    );
    const entryPath = join(packageRoot, "entry.mjs");
    await writeFile(
      entryPath,
      `globalThis[${JSON.stringify(startedKey)}](); await globalThis[${JSON.stringify(gateKey)}]; export const marker = "A";`,
    );
    const first = loadInstalledPlugin(packageRoot, { refreshable: true });
    await started;
    await writeFile(entryPath, 'export const marker = "B";');
    const second = loadInstalledPlugin(packageRoot, { refreshable: true });
    release();
    const [a, b] = await Promise.all([first, second]);
    const later = await loadInstalledPlugin(packageRoot, { refreshable: true });
    expect(a.module?.marker).toBe("A");
    expect(b.module).toBe(a.module);
    expect(b.sourceRevision).toBe(a.sourceRevision);
    expect(later.sourceRevision).toBe(a.sourceRevision);
  } finally {
    release();
    delete globals[startedKey];
    delete globals[gateKey];
    await rm(root, { recursive: true, force: true });
  }
});
