import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const bundledPluginsPath = resolve(repoRoot, "core/src/plugins/bundled.ts");
const oclifManifestPath = resolve(repoRoot, "core/oclif.manifest.json");

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

    const firstBundledPlugins = await readFile(bundledPluginsPath, "utf8");
    const firstOclifManifest = await readFile(oclifManifestPath, "utf8");

    expect(firstBundledPlugins.length).toBeGreaterThan(0);
    expect(firstOclifManifest.length).toBeGreaterThan(0);

    await runCodegen();

    expect(await readFile(bundledPluginsPath, "utf8")).toBe(firstBundledPlugins);
    expect(await readFile(oclifManifestPath, "utf8")).toBe(firstOclifManifest);
    // Runs the whole generator catalog twice; the catalog grows over time, so the
    // idempotency assertion needs headroom beyond the default per-test timeout.
  }, 60000);
});
