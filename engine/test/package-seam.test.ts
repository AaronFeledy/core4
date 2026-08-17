import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { collectShardedTestFiles } from "../../scripts/test-shards.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const packageManifestPath = resolve(repositoryRoot, "engine/package.json");

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

describe("Engine package seam", () => {
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
    const exports = stringRecord(packageManifest.exports);
    const packageEntry = realpathSync(Bun.resolveSync("@lando/engine", repositoryRoot)).replaceAll("\\", "/");
    const packageModule: unknown = await import("@lando/engine");

    expect(packageManifest.name).toBe("@lando/engine");
    expect(packageManifest.private).toBe(true);
    expect(packageManifest.main).toBe("./src/index.ts");
    expect(packageManifest.types).toBe("./src/index.ts");
    expect(exports).toEqual({
      ".": "./src/index.ts",
      "./*": "./src/*.ts",
      "./package.json": "./package.json",
    });
    expect(stringArray(rootManifest.workspaces)).toContain("engine");
    expect(projectReferencePaths(rootTsconfig.references)).toContain("./engine");
    expect(scripts).toEqual({
      build: "tsc -b",
      clean: "rm -rf dist .tsbuildinfo",
      test: "bun test ./test",
      typecheck: "tsc -b",
    });
    expect(packageEntry).toEndWith("/engine/src/index.ts");
    expect(isJsonObject(packageModule)).toBe(true);
    if (!isJsonObject(packageModule)) throw new TypeError("Expected the Engine entry point to be a module");
    expect(Object.keys(packageModule)).toEqual([]);
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
    const runtimeDependencies = Object.entries(stringRecord(packageManifest.dependencies))
      .filter(([, version]) => !version.startsWith("workspace:"))
      .sort(([left], [right]) => left.localeCompare(right));
    const nonWorkspaceDevDependencies = Object.entries(stringRecord(packageManifest.devDependencies))
      .filter(([, version]) => !version.startsWith("workspace:"))
      .sort(([left], [right]) => left.localeCompare(right));

    expect(workspaceDependencies).toEqual([
      ["@lando/container-runtime", "workspace:*"],
      ["@lando/http-client", "workspace:*"],
      ["@lando/landofile", "workspace:*"],
      ["@lando/paths", "workspace:*"],
      ["@lando/redaction", "workspace:*"],
      ["@lando/sdk", "workspace:*"],
      ["@lando/state-store", "workspace:*"],
      ["@lando/telemetry", "workspace:*"],
    ]);
    expect(workspaceDevDependencies).toEqual([]);
    expect(workspacePeerDependencies).toEqual([]);
    expect(runtimeDependencies).toEqual([
      ["effect", "^3.21.2"],
      ["semver", "^7.8.5"],
    ]);
    expect(nonWorkspaceDevDependencies).toEqual([["@types/semver", "^7.7.1"]]);
  });

  test("runs the package seam test in CI unit shards", async () => {
    // Given / When
    const shardedTests = await collectShardedTestFiles();

    // Then
    expect(shardedTests).toContain("engine/test/package-seam.test.ts");
  });
});
