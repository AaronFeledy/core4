import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtureFiles = [
  "package.json",
  "biome.json",
  "core/package.json",
  "scripts/_codegen-output.ts",
  "scripts/build-command-registry-manifest.ts",
  "scripts/build-command-reference.ts",
] as const;

type RepositoryFixture = {
  readonly root: string;
  readonly legacyManifestPath: string;
  readonly legacyCompiledManifestPath: string;
  readonly generatedManifestPath: string;
  readonly generatedCommandIdsPath: string;
  readonly generatorPath: string;
  readonly commandReferenceGeneratorPath: string;
  readonly commandReferencePath: string;
};

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

const isCommandRegistryManifestModule = (value: unknown): value is CommandRegistryManifestModule => {
  if (typeof value !== "object" || value === null || !("COMMAND_REGISTRY_MANIFEST" in value)) {
    return false;
  }

  const manifest = value.COMMAND_REGISTRY_MANIFEST;
  if (typeof manifest !== "object" || manifest === null || !("commands" in manifest)) {
    return false;
  }
  if (typeof manifest.commands !== "object" || manifest.commands === null) return false;
  if (!("source" in manifest) || manifest.source !== "built-in-command-registry") return false;

  return "version" in manifest && typeof manifest.version === "string";
};

const createRepositoryFixture = async (): Promise<RepositoryFixture> => {
  const root = await mkdtemp(join(tmpdir(), "lando-command-registry-"));
  await cp(resolve(repoRoot, "core/src"), resolve(root, "core/src"), { recursive: true });
  await Promise.all(
    fixtureFiles.map(async (path) => {
      const destination = resolve(root, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(repoRoot, path), destination);
    }),
  );
  await symlink(resolve(repoRoot, "node_modules"), resolve(root, "node_modules"), "dir");
  await mkdir(resolve(root, "docs/reference"), { recursive: true });

  return {
    root,
    legacyManifestPath: resolve(root, "core/oclif.manifest.json"),
    legacyCompiledManifestPath: resolve(root, "core/src/cli/oclif/compiled-manifest.ts"),
    generatedManifestPath: resolve(root, "core/src/cli/generated/command-registry-manifest.ts"),
    generatedCommandIdsPath: resolve(root, "core/src/cli/generated/command-ids.ts"),
    generatorPath: resolve(root, "scripts/build-command-registry-manifest.ts"),
    commandReferenceGeneratorPath: resolve(root, "scripts/build-command-reference.ts"),
    commandReferencePath: resolve(root, "docs/reference/commands.mdx"),
  };
};

const runScript = (fixture: RepositoryFixture, path: string): void => {
  const proc = Bun.spawnSync([process.execPath, path], {
    cwd: fixture.root,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect({
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }).toMatchObject({ exitCode: 0 });
};

let fixture: RepositoryFixture;

beforeEach(async () => {
  fixture = await createRepositoryFixture();
});

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

describe("embedded command registry manifest", () => {
  test("generator first-materializes registry outputs without a JSON sidecar", async () => {
    // Given
    await Promise.all([
      rm(fixture.generatedManifestPath, { force: true }),
      rm(fixture.generatedCommandIdsPath, { force: true }),
    ]);
    await writeFile(fixture.legacyManifestPath, '{ "stale": true }\n', "utf8");
    await writeFile(fixture.legacyCompiledManifestPath, "export const stale = true;\n", "utf8");

    // When
    runScript(fixture, fixture.generatorPath);

    // Then
    expect(await Bun.file(fixture.legacyManifestPath).exists()).toBe(false);
    expect(await Bun.file(fixture.legacyCompiledManifestPath).exists()).toBe(false);
    const importedManifest: unknown = await import(
      `${pathToFileURL(fixture.generatedManifestPath).href}?generated=${Date.now()}`
    );
    const { builtInCommandEntries } = await import("../../src/cli/built-in-command-registry.ts");
    const isManifestModule = isCommandRegistryManifestModule(importedManifest);
    expect(isManifestModule).toBe(true);
    if (!isManifestModule) return;

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
    runScript(fixture, fixture.generatorPath);
    const first = await readFile(fixture.generatedManifestPath, "utf8");

    // When
    runScript(fixture, fixture.generatorPath);

    // Then
    expect(await readFile(fixture.generatedManifestPath, "utf8")).toBe(first);
  });

  test("command reference preserves registry-keyed arguments and flags", async () => {
    // Given
    runScript(fixture, fixture.generatorPath);

    // When
    runScript(fixture, fixture.commandReferenceGeneratorPath);

    // Then
    const reference = await readFile(fixture.commandReferencePath, "utf8");
    expect(reference).toContain("| `command` | Command to run (first positional). |");
    expect(reference).toContain("| `--follow, -f` | Stream new log lines until interrupted. |");
  });
});
