import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ComposeFixtureEntry {
  readonly path: string;
  readonly vendored: string;
  readonly sha256: string;
}

interface ComposeFixtureSource {
  readonly path: string;
  readonly vendored: string;
  readonly bytes: ArrayBuffer;
}

type ComposeFixtureMaintenance = {
  readonly fixturesRoot: string;
  readonly pinPath: string;
  readonly fetchFixtures: (
    ref: string,
    entries: ReadonlyArray<ComposeFixtureEntry>,
  ) => Promise<ReadonlyArray<ComposeFixtureSource>>;
  readonly regenerateManifest: () => Promise<void>;
};

type ComposeFixtureBuildModule = {
  readonly refreshComposeFixtures: (maintenance: ComposeFixtureMaintenance) => Promise<void>;
  readonly bumpComposeFixtures: (ref: string, maintenance: ComposeFixtureMaintenance) => Promise<void>;
};

type ComposeFixtureManifestModule = {
  readonly generateComposeFixtureManifest: (paths: {
    readonly fixturesRoot: string;
    readonly manifestPath: string;
  }) => Promise<number>;
};

type ComposeFixtureModule = {
  readonly buildComposeFixturePin: (ref: string, files: ReadonlyArray<ComposeFixtureSource>) => unknown;
};

const isComposeFixtureBuildModule = (value: unknown): value is ComposeFixtureBuildModule =>
  typeof value === "object" &&
  value !== null &&
  "refreshComposeFixtures" in value &&
  typeof value.refreshComposeFixtures === "function" &&
  value.refreshComposeFixtures.length === 1 &&
  "bumpComposeFixtures" in value &&
  typeof value.bumpComposeFixtures === "function" &&
  value.bumpComposeFixtures.length === 2;

const repoRoot = resolve(import.meta.dir, "../../..");
const buildModule: unknown = await import(
  pathToFileURL(resolve(repoRoot, "scripts/build-compose-fixtures.ts")).href
);
const manifestModule = (await import(
  pathToFileURL(resolve(repoRoot, "scripts/build-compose-fixture-manifest.ts")).href
)) as ComposeFixtureManifestModule;
const fixtureModule = (await import(
  pathToFileURL(resolve(repoRoot, "scripts/compose-fixtures.ts")).href
)) as ComposeFixtureModule;
const oldRef = "1".repeat(40);
const newRef = "2".repeat(40);
const fixtureContent = "services: {}\n";

const withMaintenance = async (
  run: (module: ComposeFixtureBuildModule, maintenance: ComposeFixtureMaintenance) => Promise<void>,
): Promise<void> => {
  expect(isComposeFixtureBuildModule(buildModule)).toBe(true);
  if (!isComposeFixtureBuildModule(buildModule)) return;
  const fixturesRoot = await mkdtemp(join(tmpdir(), "lando-compose-refresh-"));
  try {
    await mkdir(join(fixturesRoot, "corpus"), { recursive: true });
    await mkdir(join(fixturesRoot, "upstream"), { recursive: true });
    const pinPath = join(fixturesRoot, "pin.json");
    const manifestPath = join(fixturesRoot, "manifest.json");
    const source = {
      path: "tests/minimal/compose.yaml",
      vendored: "upstream/minimal.compose.yaml",
      bytes: await new Blob([fixtureContent]).arrayBuffer(),
    } satisfies ComposeFixtureSource;
    await writeFile(join(fixturesRoot, source.vendored), "services:\n  stale: {}\n", "utf8");
    await Bun.write(
      pinPath,
      `${JSON.stringify(fixtureModule.buildComposeFixturePin(oldRef, [source]), null, 2)}\n`,
    );
    const maintenance = {
      fixturesRoot,
      pinPath,
      fetchFixtures: async () => [source],
      regenerateManifest: async () => {
        await manifestModule.generateComposeFixtureManifest({ fixturesRoot, manifestPath });
      },
    } satisfies ComposeFixtureMaintenance;

    await run(buildModule, maintenance);

    expect(await Bun.file(manifestPath).json()).toEqual({ "upstream/minimal.compose.yaml": [] });
  } finally {
    await rm(fixturesRoot, { recursive: true, force: true });
  }
};

test("refresh regenerates the rejection manifest from newly written pinned fixtures", async () => {
  // Given / When / Then
  await withMaintenance(async (module, maintenance) => module.refreshComposeFixtures(maintenance));
});

test("bump regenerates the rejection manifest from newly written bumped fixtures", async () => {
  // Given / When
  await withMaintenance(async (module, maintenance) => {
    await module.bumpComposeFixtures(newRef, maintenance);

    // Then
    expect((await Bun.file(maintenance.pinPath).json()).ref).toBe(newRef);
  });
});
