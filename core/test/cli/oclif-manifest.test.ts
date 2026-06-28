import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { loadCompiledManifest } from "../../src/cli/oclif/manifest.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const manifestJsonPath = resolve(repoRoot, "core/oclif.manifest.json");
const compiledManifestPath = resolve(repoRoot, "core/src/cli/oclif/compiled-manifest.ts");
const generatorPath = resolve(repoRoot, "scripts/build-oclif-manifest.ts");

const runGenerator = (): void => {
  const proc = Bun.spawnSync([process.execPath, generatorPath], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect({
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }).toMatchObject({ exitCode: 0 });
};

describe("compiled OCLIF manifest asset", () => {
  test("loadCompiledManifest returns the embedded generated manifest", () => {
    const manifest = loadCompiledManifest();

    expect(manifest.version).toBe("0.0.0");
    expect(Object.keys(manifest.commands).length).toBeGreaterThan(0);
    expect(manifest.commands["apps:init"]?.id).toBe("apps:init");
    expect(manifest.commands["meta:version"]?.id).toBe("meta:version");
  });

  test("generator emits JSON and keeps the committed TypeScript manifest idempotent", async () => {
    const beforeCompiled = await readFile(compiledManifestPath, "utf8");

    runGenerator();

    const manifestJson = JSON.parse(await readFile(manifestJsonPath, "utf8")) as {
      readonly commands: Readonly<Record<string, { readonly flags?: Readonly<Record<string, unknown>> }>>;
      readonly version: string;
    };
    expect(manifestJson.version).toBe("0.0.0");
    expect(Object.keys(manifestJson.commands).sort()).toEqual(
      Object.keys(loadCompiledManifest().commands).sort(),
    );
    expect(Object.keys(manifestJson.commands["meta:update"]?.flags ?? {}).sort()).toEqual([
      "channel",
      "dry-run",
      "format",
      "json",
    ]);
    expect(manifestJson.commands["meta:update"]?.flags?.channel).not.toHaveProperty("default");
    expect(await readFile(compiledManifestPath, "utf8")).toBe(beforeCompiled);
  });
});
