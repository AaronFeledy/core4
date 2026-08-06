import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { collectShardedTestFiles } from "../../../scripts/test-shards.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const packageManifestPath = resolve(repositoryRoot, "landofile/package.json");

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonObject = async (path: string): Promise<Readonly<Record<string, unknown>>> => {
  const value: unknown = await Bun.file(path).json();
  if (isJsonObject(value)) return value;
  throw new TypeError(`Expected a JSON object at ${path}`);
};

const stringRecord = (value: unknown): Readonly<Record<string, string>> => {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const projectReferencePaths = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isJsonObject(entry) || typeof entry.path !== "string") return [];
    return [entry.path];
  });
};

describe("Landofile package seam", () => {
  test("resolves the private package from the workspace scaffold", async () => {
    // Given
    const packageExists = await Bun.file(packageManifestPath).exists();

    // When / Then
    expect(packageExists).toBe(true);
    if (!packageExists) return;

    const [packageManifest, rootManifest, rootTsconfig] = await Promise.all([
      readJsonObject(packageManifestPath),
      readJsonObject(resolve(repositoryRoot, "package.json")),
      readJsonObject(resolve(repositoryRoot, "tsconfig.json")),
    ]);
    const scripts = stringRecord(packageManifest.scripts);
    const packageEntry = realpathSync(Bun.resolveSync("@lando/landofile", repositoryRoot)).replaceAll(
      "\\",
      "/",
    );
    const packageModule: unknown = await import("@lando/landofile");

    expect(packageManifest.name).toBe("@lando/landofile");
    expect(packageManifest.private).toBe(true);
    expect(packageManifest.main).toBe("./src/index.ts");
    expect(packageManifest.types).toBe("./src/index.ts");
    expect(stringArray(rootManifest.workspaces)).toContain("landofile");
    expect(projectReferencePaths(rootTsconfig.references)).toContain("./landofile");
    expect(scripts).toEqual({
      build: "tsc -b",
      clean: "rm -rf dist .tsbuildinfo",
      test: "bun test ./test",
      typecheck: "tsc -b",
    });
    expect(packageEntry).toEndWith("/landofile/src/index.ts");
    expect(isJsonObject(packageModule)).toBe(true);
    if (!isJsonObject(packageModule))
      throw new TypeError("Expected the Landofile entry point to be a module");
    expect(typeof packageModule.makeLandofileServiceLive).toBe("function");
    expect(stringRecord(packageManifest.exports)).toMatchObject({
      ".": "./src/index.ts",
      "./includes": "./src/includes.ts",
      "./parser": "./src/parser.ts",
      "./ports": "./src/ports.ts",
      "./serializer": "./src/serializer.ts",
      "./service": "./src/service.ts",
      "./version-constraint": "./src/version-constraint.ts",
    });
  });

  test("declares only approved seam dependencies", async () => {
    // Given
    const packageExists = await Bun.file(packageManifestPath).exists();

    // When / Then
    expect(packageExists).toBe(true);
    if (!packageExists) return;

    const packageManifest = await readJsonObject(packageManifestPath);
    const workspaceDependencies = Object.entries(stringRecord(packageManifest.dependencies))
      .filter(([, version]) => version.startsWith("workspace:"))
      .sort(([left], [right]) => left.localeCompare(right));
    const workspaceDevDependencies = Object.entries(stringRecord(packageManifest.devDependencies)).filter(
      ([, version]) => version.startsWith("workspace:"),
    );
    const workspacePeerDependencies = Object.entries(stringRecord(packageManifest.peerDependencies)).filter(
      ([, version]) => version.startsWith("workspace:"),
    );

    expect(workspaceDependencies).toEqual([
      ["@lando/paths", "workspace:*"],
      ["@lando/sdk", "workspace:*"],
      ["@lando/state-store", "workspace:*"],
    ]);
    expect(workspaceDevDependencies).toEqual([]);
    expect(workspacePeerDependencies).toEqual([]);
  });

  test("declares every imported external package directly", async () => {
    // Given / When
    const packageManifest = await readJsonObject(packageManifestPath);
    const dependencies = stringRecord(packageManifest.dependencies);
    const devDependencies = stringRecord(packageManifest.devDependencies);

    // Then
    expect(dependencies.effect).toBe("^3.21.2");
    expect(dependencies.semver).toBe("^7.8.5");
    expect(devDependencies["@types/semver"]).toBe("^7.7.1");
  });

  test("routes @lando/core/landofile through the package serializer subpath", async () => {
    // Given
    const publicEntry = realpathSync(Bun.resolveSync("@lando/core/landofile", repositoryRoot)).replaceAll(
      "\\",
      "/",
    );
    const serializerEntry = realpathSync(
      Bun.resolveSync("@lando/landofile/serializer", repositoryRoot),
    ).replaceAll("\\", "/");

    // When
    const shimSource = await Bun.file(resolve(repositoryRoot, "core/src/landofile/index.ts")).text();

    // Then
    expect(publicEntry).toEndWith("/core/src/landofile/index.ts");
    expect(serializerEntry).toEndWith("/landofile/src/serializer.ts");
    expect(shimSource).toContain('export * from "@lando/landofile/serializer";');
    expect(shimSource).not.toMatch(/from "@lando\/sdk\/landofile"/u);
  });

  test("keeps the core serializer entry point export-identical to the sdk source", async () => {
    // Given / When
    const coreModule: unknown = await import("@lando/core/landofile");
    const sdkModule: unknown = await import("@lando/sdk/landofile");

    // Then
    if (!isJsonObject(coreModule) || !isJsonObject(sdkModule)) {
      throw new TypeError("Expected both serializer entry points to be modules");
    }
    expect(Object.keys(coreModule).sort()).toEqual(Object.keys(sdkModule).sort());
    expect(Object.keys(coreModule).sort()).toEqual(
      [
        "LandofileEmitError",
        "detectLandofileTags",
        "emitLandofileYaml",
        "emitLandofileYamlEither",
        "parseLandofile",
      ].sort(),
    );
  });

  test("declares the Landofile implementation edge from core", async () => {
    // Given / When
    const coreManifest = await readJsonObject(resolve(repositoryRoot, "core/package.json"));
    const dependencies = stringRecord(coreManifest.dependencies);

    // Then
    expect(dependencies["@lando/landofile"]).toBe("workspace:*");
  });

  test("runs the package seam test in CI unit shards", async () => {
    // Given / When
    const shardedTests = await collectShardedTestFiles();

    // Then
    expect(shardedTests).toContain("core/test/build/landofile-package-seam.test.ts");
  });
});
