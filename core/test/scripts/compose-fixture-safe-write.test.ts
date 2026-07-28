import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

interface ComposeFixtureMaintenance {
  readonly trustedRoot: string;
  readonly fixturesRoot: string;
  readonly pinPath: string;
  readonly fetchFixtures: (
    ref: string,
    entries: ReadonlyArray<ComposeFixtureEntry>,
  ) => Promise<ReadonlyArray<ComposeFixtureSource>>;
  readonly regenerateManifest: () => Promise<void>;
}

interface ComposeFixtureBuildModule {
  readonly refreshComposeFixtures: (maintenance: ComposeFixtureMaintenance) => Promise<void>;
  readonly bumpComposeFixtures: (ref: string, maintenance: ComposeFixtureMaintenance) => Promise<void>;
}

interface ComposeFixtureManifestModule {
  readonly generateComposeFixtureManifest: (paths: {
    readonly trustedRoot: string;
    readonly fixturesRoot: string;
    readonly manifestPath: string;
  }) => Promise<number>;
}

interface ComposeFixtureModule {
  readonly buildComposeFixturePin: (ref: string, files: ReadonlyArray<ComposeFixtureSource>) => unknown;
}

const isBuildModule = (value: unknown): value is ComposeFixtureBuildModule =>
  typeof value === "object" &&
  value !== null &&
  "refreshComposeFixtures" in value &&
  typeof value.refreshComposeFixtures === "function" &&
  "bumpComposeFixtures" in value &&
  typeof value.bumpComposeFixtures === "function";

const isManifestModule = (value: unknown): value is ComposeFixtureManifestModule =>
  typeof value === "object" &&
  value !== null &&
  "generateComposeFixtureManifest" in value &&
  typeof value.generateComposeFixtureManifest === "function";

const isFixtureModule = (value: unknown): value is ComposeFixtureModule =>
  typeof value === "object" &&
  value !== null &&
  "buildComposeFixturePin" in value &&
  typeof value.buildComposeFixturePin === "function";

const repoRoot = resolve(import.meta.dir, "../../..");
const buildModule: unknown = await import(
  pathToFileURL(resolve(repoRoot, "scripts/build-compose-fixtures.ts")).href
);
const manifestModule: unknown = await import(
  pathToFileURL(resolve(repoRoot, "scripts/build-compose-fixture-manifest.ts")).href
);
const fixtureModule: unknown = await import(
  pathToFileURL(resolve(repoRoot, "scripts/compose-fixtures.ts")).href
);

const oldRef = "1".repeat(40);
const newRef = "2".repeat(40);
const originalSentinel = "external sentinel\n";
const fixtureContent = "services: {}\n";

const sourceFor = async (vendored: string): Promise<ComposeFixtureSource> => ({
  path: "tests/minimal/compose.yaml",
  vendored,
  bytes: await new Blob([fixtureContent]).arrayBuffer(),
});

const writePin = async (pinPath: string, source: ComposeFixtureSource): Promise<string> => {
  if (!isFixtureModule(fixtureModule)) throw new TypeError("Compose fixture module is unavailable");
  const content = `${JSON.stringify(fixtureModule.buildComposeFixturePin(oldRef, [source]), null, 2)}\n`;
  await writeFile(pinPath, content, "utf8");
  return content;
};

const maintenanceFor = (
  fixturesRoot: string,
  pinPath: string,
  source: ComposeFixtureSource,
  trustedRoot = dirname(fixturesRoot),
): ComposeFixtureMaintenance => ({
  trustedRoot,
  fixturesRoot,
  pinPath,
  fetchFixtures: async () => [source],
  regenerateManifest: async () => undefined,
});

const linkDirectory = async (target: string, path: string): Promise<void> => {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
};

test("refresh rejects a symlinked fixture root without changing external bytes", async () => {
  // Given
  expect(isBuildModule(buildModule)).toBe(true);
  if (!isBuildModule(buildModule)) return;
  const sandbox = await mkdtemp(join(tmpdir(), "lando-compose-safe-root-"));
  try {
    const externalRoot = join(sandbox, "external");
    const fixturesRoot = join(sandbox, "fixtures");
    await mkdir(join(externalRoot, "upstream"), { recursive: true });
    const source = await sourceFor("upstream/minimal.compose.yaml");
    const sentinelPath = join(externalRoot, source.vendored);
    await writeFile(sentinelPath, originalSentinel, "utf8");
    const pinPath = join(externalRoot, "pin.json");
    await writePin(pinPath, source);
    await linkDirectory(externalRoot, fixturesRoot);

    // When
    const refresh = buildModule.refreshComposeFixtures(maintenanceFor(fixturesRoot, pinPath, source));

    // Then
    await expect(refresh).rejects.toMatchObject({
      name: "FixtureMaintenanceWriteError",
      failure: "symbolic-link",
    });
    expect(await Bun.file(sentinelPath).text()).toBe(originalSentinel);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("refresh rejects a symlinked fixture ancestor without changing external bytes", async () => {
  // Given
  expect(isBuildModule(buildModule)).toBe(true);
  if (!isBuildModule(buildModule)) return;
  const sandbox = await mkdtemp(join(tmpdir(), "lando-compose-safe-ancestor-"));
  try {
    const trustedRoot = join(sandbox, "workspace");
    const externalRoot = join(sandbox, "external");
    const fixturesRoot = join(trustedRoot, "core/test/fixtures/compose");
    await mkdir(trustedRoot);
    await mkdir(join(externalRoot, "test/fixtures/compose/upstream"), { recursive: true });
    await linkDirectory(externalRoot, join(trustedRoot, "core"));
    const source = await sourceFor("upstream/minimal.compose.yaml");
    const sentinelPath = join(externalRoot, "test/fixtures/compose", source.vendored);
    await writeFile(sentinelPath, originalSentinel, "utf8");
    const pinPath = join(externalRoot, "test/fixtures/compose/pin.json");
    await writePin(pinPath, source);

    // When
    const refresh = buildModule.refreshComposeFixtures(
      maintenanceFor(fixturesRoot, pinPath, source, trustedRoot),
    );

    // Then
    await expect(refresh).rejects.toMatchObject({
      name: "FixtureMaintenanceWriteError",
      failure: "symbolic-link",
    });
    expect(await Bun.file(sentinelPath).text()).toBe(originalSentinel);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("refresh rejects a symlinked vendored parent without changing external bytes", async () => {
  // Given
  expect(isBuildModule(buildModule)).toBe(true);
  if (!isBuildModule(buildModule)) return;
  const sandbox = await mkdtemp(join(tmpdir(), "lando-compose-safe-parent-"));
  try {
    const fixturesRoot = join(sandbox, "fixtures");
    const externalRoot = join(sandbox, "external");
    await mkdir(fixturesRoot);
    await mkdir(externalRoot);
    await linkDirectory(externalRoot, join(fixturesRoot, "upstream"));
    const source = await sourceFor("upstream/minimal.compose.yaml");
    const sentinelPath = join(externalRoot, "minimal.compose.yaml");
    await writeFile(sentinelPath, originalSentinel, "utf8");
    const pinPath = join(fixturesRoot, "pin.json");
    await writePin(pinPath, source);

    // When
    const refresh = buildModule.refreshComposeFixtures(maintenanceFor(fixturesRoot, pinPath, source));

    // Then
    await expect(refresh).rejects.toMatchObject({
      name: "FixtureMaintenanceWriteError",
      failure: "symbolic-link",
    });
    expect(await Bun.file(sentinelPath).text()).toBe(originalSentinel);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("refresh rejects a symlinked vendored destination without changing external bytes", async () => {
  // Given
  expect(isBuildModule(buildModule)).toBe(true);
  if (!isBuildModule(buildModule)) return;
  const sandbox = await mkdtemp(join(tmpdir(), "lando-compose-safe-destination-"));
  try {
    const fixturesRoot = join(sandbox, "fixtures");
    await mkdir(join(fixturesRoot, "upstream"), { recursive: true });
    const source = await sourceFor("upstream/minimal.compose.yaml");
    const sentinelPath = join(sandbox, "sentinel.compose.yaml");
    await writeFile(sentinelPath, originalSentinel, "utf8");
    await symlink(sentinelPath, join(fixturesRoot, source.vendored), "file");
    const pinPath = join(fixturesRoot, "pin.json");
    await writePin(pinPath, source);

    // When
    const refresh = buildModule.refreshComposeFixtures(maintenanceFor(fixturesRoot, pinPath, source));

    // Then
    await expect(refresh).rejects.toMatchObject({
      name: "FixtureMaintenanceWriteError",
      failure: "symbolic-link",
    });
    expect(await Bun.file(sentinelPath).text()).toBe(originalSentinel);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("bump rejects a symlinked pin destination without changing external bytes", async () => {
  // Given
  expect(isBuildModule(buildModule)).toBe(true);
  if (!isBuildModule(buildModule)) return;
  const sandbox = await mkdtemp(join(tmpdir(), "lando-compose-safe-pin-"));
  try {
    const fixturesRoot = join(sandbox, "fixtures");
    await mkdir(join(fixturesRoot, "upstream"), { recursive: true });
    const source = await sourceFor("upstream/minimal.compose.yaml");
    const sentinelPath = join(sandbox, "sentinel-pin.json");
    const originalPin = await writePin(sentinelPath, source);
    const pinPath = join(fixturesRoot, "pin.json");
    await symlink(sentinelPath, pinPath, "file");

    // When
    const bump = buildModule.bumpComposeFixtures(newRef, maintenanceFor(fixturesRoot, pinPath, source));

    // Then
    await expect(bump).rejects.toMatchObject({
      name: "FixtureMaintenanceWriteError",
      failure: "symbolic-link",
    });
    expect(await Bun.file(sentinelPath).text()).toBe(originalPin);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("manifest generation rejects a symlinked destination without changing external bytes", async () => {
  // Given
  expect(isManifestModule(manifestModule)).toBe(true);
  if (!isManifestModule(manifestModule)) return;
  const sandbox = await mkdtemp(join(tmpdir(), "lando-compose-safe-manifest-"));
  try {
    const fixturesRoot = join(sandbox, "fixtures");
    await mkdir(join(fixturesRoot, "corpus"), { recursive: true });
    await mkdir(join(fixturesRoot, "upstream"), { recursive: true });
    await writeFile(join(fixturesRoot, "corpus", "minimal.compose.yaml"), fixtureContent, "utf8");
    const sentinelPath = join(sandbox, "sentinel-manifest.json");
    await writeFile(sentinelPath, originalSentinel, "utf8");
    const manifestPath = join(fixturesRoot, "manifest.json");
    await symlink(sentinelPath, manifestPath, "file");

    // When
    const generate = manifestModule.generateComposeFixtureManifest({
      trustedRoot: sandbox,
      fixturesRoot,
      manifestPath,
    });

    // Then
    await expect(generate).rejects.toMatchObject({
      name: "FixtureMaintenanceWriteError",
      failure: "symbolic-link",
    });
    expect(await Bun.file(sentinelPath).text()).toBe(originalSentinel);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
