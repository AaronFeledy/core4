import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  FileSystemCall,
  LoggerCall,
  RendererCall,
  TestRuntime,
  TestRuntimeCalls,
  TestRuntimeOptions,
} from "@lando/core/testing";

import corePackage from "../../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(import.meta.dirname, "../..");
const sdkRoot = resolve(repoRoot, "sdk");
const containerRuntimeRoot = resolve(repoRoot, "container-runtime");
const externalDependencyRoot = resolve(repoRoot, "node_modules");
const workspaceDependencyRoots: Readonly<Record<string, string>> = {
  "@lando/container-runtime": containerRuntimeRoot,
  "@lando/sdk": sdkRoot,
};

const dependencySource = (dependency: string): string =>
  workspaceDependencyRoots[dependency] ?? join(externalDependencyRoot, dependency);

const dependencyNamesFrom = async (packageRoot: string): Promise<ReadonlyArray<string>> => {
  const packageJson: unknown = JSON.parse(await Bun.file(join(packageRoot, "package.json")).text());
  if (packageJson === null || typeof packageJson !== "object") return [];
  const dependencies = Reflect.get(packageJson, "dependencies");
  return dependencies === null || typeof dependencies !== "object" ? [] : Object.keys(dependencies);
};

const packedConsumerDependencyClosure = async (): Promise<ReadonlyArray<string>> => {
  const pending = Object.keys(corePackage.dependencies);
  const dependencies = new Set<string>();
  while (pending.length > 0) {
    const dependency = pending.shift();
    if (dependency === undefined || dependencies.has(dependency)) continue;
    dependencies.add(dependency);
    pending.push(...(await dependencyNamesFrom(dependencySource(dependency))));
  }
  return [...dependencies].sort();
};

type TestingTypeExportCheck = {
  readonly runtime?: TestRuntime;
  readonly options: TestRuntimeOptions;
  readonly calls: TestRuntimeCalls;
  readonly logger?: LoggerCall;
  readonly renderer?: RendererCall;
  readonly fileSystem?: FileSystemCall;
};

const testingTypeExportCheck: TestingTypeExportCheck = {
  options: {},
  calls: { logger: [], renderer: [], events: [], fileSystem: [], processRunner: [], config: [] },
};

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PWD: cwd },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const assertCommandSucceeded = (label: string, result: RunResult) => {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
};

describe("@lando/core/testing package export", () => {
  test("resolves from the workspace package name", async () => {
    const testing = await import("@lando/core/testing");

    expect(testing.TestRuntimeProvider.id).toBe("test");
    expect(testing.makeTestRuntime).toBeFunction();
    expect(testing.provideTestRuntime).toBeFunction();
    expect(testing.withService).toBeFunction();
    expect(testing.TestRuntimeLayer).toBeDefined();
    expect(testing.TestRemoteSource).toBeDefined();
    expect(testing.makeTestRemoteSource).toBeFunction();
    expect(testing.localRemoteSource).toBeDefined();
    expect(testing.TestDataset).toBeDefined();
    expect(testing.makeTestDataset).toBeFunction();
    expect(testing.TestDataMover).toBeDefined();
    expect(testing.makeTestDataMover).toBeFunction();
    expect(testing.TestTunnelService).toBeDefined();
    expect(testing.makeTestTunnelService).toBeFunction();
    expect(testing.TestSecretStore).toBeDefined();
    expect(testing.makeTestSecretStore).toBeFunction();
    expect(testing.ScenarioContext).toBeDefined();
    expect(testing.withScenarioContext).toBeFunction();
    expect(testing.ScenarioContextFactory).toBeDefined();
    expect(testing.makeTestInteractionService).toBeFunction();
    expect(testing.expectEvent).toBeFunction();
    expect(testing.waitForEvent).toBeFunction();
    expect(testing.recordedEvents).toBeFunction();
    expect(testing.TestClock).toBeDefined();
    expect(testing.TestContext).toBeDefined();
    expect(testingTypeExportCheck.options).toEqual({});
    expect(corePackage.exports["./testing"]).toEqual({
      types: "./src/testing/index.ts",
      import: "./src/testing/index.ts",
    });
    expect(await realpath(Bun.resolveSync("@lando/core/testing", repoRoot))).toBe(
      await realpath(join(coreRoot, "src/testing/index.ts")),
    );
  });

  test("resolves from a packed package install", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lando-core-testing-export-"));

    try {
      const archiveName = "lando-core-test.tgz";
      const archivePath = join(tempDir, archiveName);
      const pack = await runCommand(
        [process.execPath, "pm", "pack", "--filename", archivePath, "--ignore-scripts", "--quiet"],
        coreRoot,
      );
      expect(pack.exitCode).toBe(0);

      const list = await runCommand(
        ["tar", "-tzf", archivePath, "package/package.json", "package/src/testing/index.ts"],
        tempDir,
      );
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("package/package.json");
      expect(list.stdout).toContain("package/src/testing/index.ts");

      const extractDir = join(tempDir, "extract");
      await mkdir(extractDir);
      const extract = await runCommand(
        ["tar", "-xzf", archivePath, "-C", extractDir, "package/package.json", "package/src"],
        tempDir,
      );
      expect(extract.exitCode).toBe(0);

      const consumerDir = join(tempDir, "consumer");
      const scopedDir = join(consumerDir, "node_modules/@lando");
      await mkdir(scopedDir, { recursive: true });
      await symlink(join(extractDir, "package"), join(scopedDir, "core"), "dir");
      const extractNodeModules = join(extractDir, "package", "node_modules");

      for (const dependency of await packedConsumerDependencyClosure()) {
        const source = dependencySource(dependency);
        const consumerTarget = join(consumerDir, "node_modules", dependency);
        const extractTarget = join(extractNodeModules, dependency);
        await mkdir(resolve(consumerTarget, ".."), { recursive: true });
        await mkdir(resolve(extractTarget, ".."), { recursive: true });
        await symlink(source, consumerTarget, "dir");
        await symlink(source, extractTarget, "dir");
      }

      const resolved = await runCommand(
        [
          process.execPath,
          "-e",
          "const mod = await import('@lando/core/testing'); const names = ['makeTestRuntime', 'provideTestRuntime', 'withService', 'TestRuntimeLayer', 'TestRuntimeProvider', 'TestRemoteSource', 'makeTestRemoteSource', 'localRemoteSource', 'TestDataset', 'makeTestDataset', 'TestDataMover', 'makeTestDataMover', 'TestTunnelService', 'makeTestTunnelService', 'ScenarioContext', 'withScenarioContext', 'ScenarioContextFactory', 'TestClock', 'TestContext']; const missing = names.filter((name) => mod[name] === undefined); console.log(mod.TestRuntimeProvider.id); console.log(JSON.stringify(missing)); console.log(Bun.resolveSync('@lando/core/testing', process.cwd())); process.exit(missing.length === 0 ? 0 : 1);",
        ],
        consumerDir,
      );

      assertCommandSucceeded("packed @lando/core/testing import", resolved);
      expect(resolved.stderr).toBe("");
      const outputLines = resolved.stdout.trimEnd().split("\n");
      expect(outputLines[0]).toBe("test");
      expect(JSON.parse(outputLines[1] ?? "[]")).toEqual([]);
      const resolvedPath = outputLines.at(-1);
      if (resolvedPath === undefined)
        throw new Error("packed @lando/core/testing import did not print a path");
      const actualResolvedPath = await realpath(resolvedPath);
      const expectedResolvedPath = await realpath(join(extractDir, "package/src/testing/index.ts"));
      expect(actualResolvedPath).toBe(expectedResolvedPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
