import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const mirrorScriptUrl = pathToFileURL(resolve(repoRoot, "scripts/mirror-schema-artifacts.ts"));
const generatorPath = resolve(repoRoot, "scripts/build-schema-snapshot.ts");
const schemaFamilies = ["schemas", "command-schemas"] as const;

interface SchemaMirrorModule {
  readonly mirrorSchemaArtifacts: (input: { readonly repoRoot: string }) => Promise<void>;
}

interface NpmPackResult {
  readonly files: ReadonlyArray<{ readonly path: string }>;
}

const loadSchemaMirror = async (): Promise<SchemaMirrorModule> => import(mirrorScriptUrl.href);

const generateSchemaArtifacts = (): void => {
  const generated = Bun.spawnSync([process.execPath, generatorPath], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ exitCode: generated.exitCode, stderr: generated.stderr.toString() }).toMatchObject({
    exitCode: 0,
  });
};

const withTempRepo = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(resolve(tmpdir(), "lando-schema-mirror-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const writeCanonicalTrees = async (root: string): Promise<void> => {
  await mkdir(resolve(root, "dist/schemas/nested"), { recursive: true });
  await mkdir(resolve(root, "dist/command-schemas"), { recursive: true });
  await writeFile(resolve(root, "dist/schemas/nested/public.json"), Buffer.from([0, 1, 2, 10, 255]));
  await writeFile(
    resolve(root, "dist/command-schemas/result.json"),
    Buffer.from('{\r\n  "ok": true\r\n}\r\n'),
  );
};

const listJsonFiles = async (root: string, directory = root): Promise<ReadonlyArray<string>> => {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await listJsonFiles(root, path)));
    if (entry.isFile() && entry.name.endsWith(".json")) paths.push(relative(root, path));
  }
  return paths.sort();
};

const directoryExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("schema artifact package mirror", () => {
  test("creates both mirror directories and copies canonical JSON trees byte-identically", async () => {
    await withTempRepo(async (root) => {
      // Given
      await writeCanonicalTrees(root);

      // When
      const { mirrorSchemaArtifacts } = await loadSchemaMirror();
      await mirrorSchemaArtifacts({ repoRoot: root });

      // Then
      expect(await readFile(resolve(root, "core/dist/schemas/nested/public.json"))).toEqual(
        await readFile(resolve(root, "dist/schemas/nested/public.json")),
      );
      expect(await readFile(resolve(root, "core/dist/command-schemas/result.json"))).toEqual(
        await readFile(resolve(root, "dist/command-schemas/result.json")),
      );
    });
  });

  test("prunes stale JSON files from both package mirror trees", async () => {
    await withTempRepo(async (root) => {
      // Given
      await writeCanonicalTrees(root);
      await mkdir(resolve(root, "core/dist/schemas"), { recursive: true });
      await mkdir(resolve(root, "core/dist/command-schemas"), { recursive: true });
      const stalePaths = [
        resolve(root, "core/dist/schemas/stale.json"),
        resolve(root, "core/dist/command-schemas/stale.json"),
      ];
      await Promise.all(stalePaths.map((path) => writeFile(path, "{}\n")));

      // When
      const { mirrorSchemaArtifacts } = await loadSchemaMirror();
      await mirrorSchemaArtifacts({ repoRoot: root });

      // Then
      expect(await Promise.all(stalePaths.map((path) => Bun.file(path).exists()))).toEqual([false, false]);
    });
  });

  test(
    "mirrors every schema artifact emitted by the real schema snapshot generator with identical bytes",
    async () => {
      // Given
      const backupRoot = await mkdtemp(resolve(tmpdir(), "lando-schema-mirror-backup-"));
      const existingFamilies = new Set<string>();
      for (const family of schemaFamilies) {
        const packageDirectory = resolve(repoRoot, "core/dist", family);
        if (await directoryExists(packageDirectory)) {
          existingFamilies.add(family);
          await cp(packageDirectory, resolve(backupRoot, family), { recursive: true });
        }
      }

      try {
        generateSchemaArtifacts();

        // When
        const { mirrorSchemaArtifacts } = await loadSchemaMirror();
        await mirrorSchemaArtifacts({ repoRoot });

        // Then
        for (const family of schemaFamilies) {
          const canonicalRoot = resolve(repoRoot, "dist", family);
          const mirrorRoot = resolve(repoRoot, "core/dist", family);
          const canonicalFiles = await listJsonFiles(canonicalRoot);
          expect(await listJsonFiles(mirrorRoot), family).toEqual(canonicalFiles);
          for (const path of canonicalFiles) {
            expect(await readFile(resolve(mirrorRoot, path)), `${family}/${path}`).toEqual(
              await readFile(resolve(canonicalRoot, path)),
            );
          }
        }
      } finally {
        for (const family of schemaFamilies) {
          const packageDirectory = resolve(repoRoot, "core/dist", family);
          await rm(packageDirectory, { recursive: true, force: true });
          if (existingFamilies.has(family)) {
            await cp(resolve(backupRoot, family), packageDirectory, { recursive: true });
          }
        }
        await rm(backupRoot, { recursive: true, force: true });
      }
    },
    { timeout: 30_000 },
  );

  test(
    "packs the complete public and command schema artifact sets in the @lando/core npm tarball",
    async () => {
      // Given
      const packDestination = await mkdtemp(resolve(tmpdir(), "lando-core-pack-"));
      try {
        generateSchemaArtifacts();
        const publicIndex = JSON.parse(
          await readFile(resolve(repoRoot, "dist/schemas/index.json"), "utf8"),
        ) as ReadonlyArray<{ readonly jsonSchemaPath: string }>;
        const commandIndex = JSON.parse(
          await readFile(resolve(repoRoot, "dist/command-schemas/index.json"), "utf8"),
        ) as Readonly<Record<string, string>>;

        // When
        const packed = Bun.spawnSync(
          [
            "npm",
            "pack",
            "--dry-run",
            "--json",
            "--ignore-scripts",
            "--workspace",
            "@lando/core",
            "--pack-destination",
            packDestination,
          ],
          { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
        );

        // Then
        expect({ exitCode: packed.exitCode, stderr: packed.stderr.toString() }).toMatchObject({
          exitCode: 0,
        });
        const results = JSON.parse(packed.stdout.toString()) as ReadonlyArray<NpmPackResult>;
        const files = results[0]?.files.map(({ path }) => path).sort() ?? [];
        const expectedFiles = [
          "dist/schemas/index.json",
          ...publicIndex.map(({ jsonSchemaPath }) => jsonSchemaPath),
          "dist/command-schemas/index.json",
          ...Object.values(commandIndex),
        ].sort();
        expect(files.filter((path) => path.startsWith("dist/schemas/")).sort()).toEqual(
          expectedFiles.filter((path) => path.startsWith("dist/schemas/")),
        );
        expect(files.filter((path) => path.startsWith("dist/command-schemas/")).sort()).toEqual(
          expectedFiles.filter((path) => path.startsWith("dist/command-schemas/")),
        );
      } finally {
        await rm(packDestination, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );
});
