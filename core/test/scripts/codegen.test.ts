import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const bundledPluginPaths = [
  resolve(repoRoot, "core/src/plugins/generated/bundled.ts"),
  resolve(repoRoot, "core/src/plugins/generated/renderers.ts"),
] as const;
const bootstrapLayersIndexPath = resolve(repoRoot, "core/src/runtime/generated/layers/index.ts");
const commandRegistryManifestPath = resolve(repoRoot, "core/src/cli/generated/command-registry-manifest.ts");

const runCodegen = async (): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "codegen"],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
};

describe("codegen orchestrator", () => {
  test("regenerates current MVP outputs idempotently", async () => {
    await runCodegen();

    const firstBundledPlugins = await Promise.all(bundledPluginPaths.map((path) => readFile(path, "utf8")));
    const firstBootstrapLayersIndex = await readFile(bootstrapLayersIndexPath, "utf8");
    const firstCommandRegistryManifest = await readFile(commandRegistryManifestPath, "utf8");

    expect(firstBundledPlugins.every((source) => source.length > 0)).toBe(true);
    expect(firstBootstrapLayersIndex.length).toBeGreaterThan(0);
    expect(firstCommandRegistryManifest.length).toBeGreaterThan(0);

    await runCodegen();

    expect(await Promise.all(bundledPluginPaths.map((path) => readFile(path, "utf8")))).toEqual(
      firstBundledPlugins,
    );
    expect(await readFile(bootstrapLayersIndexPath, "utf8")).toBe(firstBootstrapLayersIndex);
    expect(await readFile(commandRegistryManifestPath, "utf8")).toBe(firstCommandRegistryManifest);
    // Runs the whole generator catalog twice; the catalog grows over time, so the
    // idempotency assertion needs headroom beyond the default per-test timeout.
  }, 60000);
});
