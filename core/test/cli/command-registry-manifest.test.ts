import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const legacyManifestPath = resolve(repoRoot, "core/oclif.manifest.json");
const legacyCompiledManifestPath = resolve(repoRoot, "core/src/cli/oclif/compiled-manifest.ts");
const generatedManifestPath = resolve(repoRoot, "core/src/cli/generated/command-registry-manifest.ts");
const generatorPath = resolve(repoRoot, "scripts/build-command-registry-manifest.ts");
const commandReferenceGeneratorPath = resolve(repoRoot, "scripts/build-command-reference.ts");
const commandReferencePath = resolve(repoRoot, "docs/reference/commands.mdx");

type ManifestCommand = {
  readonly aliases: ReadonlyArray<string>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly spec: {
    readonly bootstrap: string;
    readonly id: string;
    readonly summary: string;
  };
};

type CommandRegistryManifestModule = {
  readonly COMMAND_REGISTRY_MANIFEST: {
    readonly commands: Readonly<Record<string, ManifestCommand>>;
    readonly source: "built-in-command-registry";
    readonly version: string;
  };
};

const isCommandRegistryManifestModule = (value: unknown): value is CommandRegistryManifestModule =>
  typeof value === "object" &&
  value !== null &&
  "COMMAND_REGISTRY_MANIFEST" in value &&
  typeof value.COMMAND_REGISTRY_MANIFEST === "object" &&
  value.COMMAND_REGISTRY_MANIFEST !== null &&
  "commands" in value.COMMAND_REGISTRY_MANIFEST &&
  typeof value.COMMAND_REGISTRY_MANIFEST.commands === "object" &&
  value.COMMAND_REGISTRY_MANIFEST.commands !== null &&
  "source" in value.COMMAND_REGISTRY_MANIFEST &&
  value.COMMAND_REGISTRY_MANIFEST.source === "built-in-command-registry" &&
  "version" in value.COMMAND_REGISTRY_MANIFEST &&
  typeof value.COMMAND_REGISTRY_MANIFEST.version === "string";

const runScript = (path: string): void => {
  const proc = Bun.spawnSync([process.execPath, path], {
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

afterEach(async () => {
  await Promise.all([
    rm(legacyManifestPath, { force: true }),
    rm(legacyCompiledManifestPath, { force: true }),
  ]);
});

describe("embedded command registry manifest", () => {
  test("generator derives the embedded manifest from the native registry without a JSON sidecar", async () => {
    // Given
    await rm(generatedManifestPath, { force: true });
    await writeFile(legacyManifestPath, '{ "stale": true }\n', "utf8");
    await writeFile(legacyCompiledManifestPath, "export const stale = true;\n", "utf8");

    // When
    runScript(generatorPath);

    // Then
    expect(await Bun.file(legacyManifestPath).exists()).toBe(false);
    expect(await Bun.file(legacyCompiledManifestPath).exists()).toBe(false);
    const importedManifest: unknown = await import(
      `${pathToFileURL(generatedManifestPath).href}?generated=${Date.now()}`
    );
    const { builtInCommandEntries } = await import("../../src/cli/built-in-command-registry.ts");
    expect(isCommandRegistryManifestModule(importedManifest)).toBe(true);
    if (!isCommandRegistryManifestModule(importedManifest)) return;

    const manifest = importedManifest.COMMAND_REGISTRY_MANIFEST;
    const manifestIds = Object.keys(manifest.commands).sort();
    const registryIds = builtInCommandEntries.map((entry) => entry.spec.id).sort();
    expect(manifest.source).toBe("built-in-command-registry");
    expect(manifest.version).toBe("0.0.0");
    expect(manifestIds).toEqual(registryIds);
    for (const entry of builtInCommandEntries) {
      expect(manifest.commands[entry.spec.id]?.spec).toMatchObject({
        id: entry.spec.id,
        summary: entry.spec.summary,
        bootstrap: entry.spec.bootstrap,
      });
    }
  });

  test("generator output is idempotent", async () => {
    // Given
    runScript(generatorPath);
    const first = await readFile(generatedManifestPath, "utf8");

    // When
    runScript(generatorPath);

    // Then
    expect(await readFile(generatedManifestPath, "utf8")).toBe(first);
  });

  test("command reference preserves registry-keyed arguments and flags", async () => {
    // Given
    runScript(generatorPath);

    // When
    runScript(commandReferenceGeneratorPath);

    // Then
    const reference = await readFile(commandReferencePath, "utf8");
    expect(reference).toContain("| `command` | Command to run (first positional). |");
    expect(reference).toContain("| `--follow, -f` | Stream new log lines until interrupted. |");
  });
});
