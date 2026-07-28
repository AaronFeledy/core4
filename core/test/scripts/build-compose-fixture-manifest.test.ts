import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type ComposeFixtureManifestModule = {
  readonly generateComposeFixtureManifest: (paths: {
    readonly fixturesRoot: string;
    readonly manifestPath: string;
  }) => Promise<number>;
};

const isComposeFixtureManifestModule = (value: unknown): value is ComposeFixtureManifestModule =>
  typeof value === "object" &&
  value !== null &&
  "generateComposeFixtureManifest" in value &&
  typeof value.generateComposeFixtureManifest === "function";

const repoRoot = resolve(import.meta.dir, "../../..");
const packageJson: unknown = await Bun.file(resolve(repoRoot, "package.json")).json();
const manifestModule: unknown = await import(
  pathToFileURL(resolve(repoRoot, "scripts/build-compose-fixture-manifest.ts")).href
);
const aggregateCodegen = await Bun.file(resolve(repoRoot, "scripts/codegen.ts")).text();

test("exposes the offline Compose fixture manifest generator as a package command", () => {
  // Given
  const scripts =
    typeof packageJson === "object" && packageJson !== null && "scripts" in packageJson
      ? packageJson.scripts
      : undefined;

  // When
  const command =
    typeof scripts === "object" && scripts !== null && "codegen:compose-fixture-manifest" in scripts
      ? scripts["codegen:compose-fixture-manifest"]
      : undefined;

  // Then
  expect(command).toBe("bun run scripts/build-compose-fixture-manifest.ts");
});

test("regenerates a Compose fixture manifest offline in an isolated fixture root", async () => {
  // Given
  expect(isComposeFixtureManifestModule(manifestModule)).toBe(true);
  if (!isComposeFixtureManifestModule(manifestModule)) return;
  const root = await mkdtemp(join(tmpdir(), "lando-compose-manifest-"));
  try {
    await mkdir(join(root, "corpus"), { recursive: true });
    await mkdir(join(root, "upstream"), { recursive: true });
    await writeFile(join(root, "corpus", "minimal.compose.yaml"), "services: {}\n", "utf8");
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, "{}\n", "utf8");

    // When
    const fixtureCount = await manifestModule.generateComposeFixtureManifest({
      fixturesRoot: root,
      manifestPath,
    });

    // Then
    expect(fixtureCount).toBe(1);
    expect(await Bun.file(manifestPath).json()).toEqual({ "corpus/minimal.compose.yaml": [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("includes only offline Compose fixture generation in generic codegen", () => {
  // Given / When / Then
  expect(aggregateCodegen).toContain("build-compose-fixture-manifest.ts");
  expect(aggregateCodegen).not.toContain("build-compose-fixtures.ts");
});
