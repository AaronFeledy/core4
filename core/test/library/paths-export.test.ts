import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import corePackage from "../../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(import.meta.dirname, "../..");
const pathsRoot = resolve(repoRoot, "paths");

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

interface PackRequest {
  readonly label: string;
  readonly sourceRoot: string;
  readonly tempDir: string;
  readonly extractPaths: ReadonlyArray<string>;
}

interface PackedPackage {
  readonly archivePath: string;
  readonly extractDir: string;
}

const packWorkspacePackage = async (request: PackRequest): Promise<PackedPackage> => {
  const archivePath = join(request.tempDir, `lando-${request.label}.tgz`);
  const pack = await runCommand(
    [process.execPath, "pm", "pack", "--filename", archivePath, "--ignore-scripts", "--quiet"],
    request.sourceRoot,
  );
  assertCommandSucceeded(`bun pm pack (${request.label})`, pack);

  const extractDir = join(request.tempDir, `extract-${request.label}`);
  await mkdir(extractDir);
  const extract = await runCommand(
    ["tar", "-xzf", archivePath, "-C", extractDir, ...request.extractPaths],
    request.tempDir,
  );
  assertCommandSucceeded(`tar extract (${request.label})`, extract);

  return { archivePath, extractDir };
};

const expectArchiveContains = async (
  archivePath: string,
  cwd: string,
  entries: ReadonlyArray<string>,
): Promise<void> => {
  const list = await runCommand(["tar", "-tzf", archivePath, ...entries], cwd);
  assertCommandSucceeded(`tar list ${archivePath}`, list);
  for (const entry of entries) expect(list.stdout).toContain(entry);
};

describe("@lando/core/paths package export", () => {
  test("resolves from the workspace package name", async () => {
    const paths = (await import("@lando/core/paths")) as Record<string, unknown>;

    expect(paths.resolveLandoRoots).toBeFunction();
    expect(paths.makeLandoPaths).toBeFunction();
    expect(paths.normalizeHostPlatform).toBeFunction();
    expect(
      (
        paths.makeLandoPaths as (overrides: { readonly userDataRoot: string }) => {
          readonly managedFileLedger: (appId: string) => string;
        }
      )({
        userDataRoot: "/tmp/lando-data",
      }).managedFileLedger("app-one"),
    ).toBe("/tmp/lando-data/managed-files/app-one/ledger.json");
    expect(corePackage.exports["./paths"]).toEqual({
      types: "./src/config/paths.ts",
      import: "./src/config/paths.ts",
    });
    expect(await realpath(Bun.resolveSync("@lando/core/paths", repoRoot))).toBe(
      await realpath(join(coreRoot, "src/config/paths.ts")),
    );
  });

  test("re-exports the @lando/paths package that owns the implementation", async () => {
    const pathsPackage = await Bun.file(resolve(import.meta.dirname, "../../../paths/package.json")).json();

    expect(pathsPackage.private).toBe(true);
    expect(pathsPackage.exports).toEqual({
      ".": "./src/paths.ts",
      "./overlay": "./src/overlay.ts",
      "./yaml-min": "./src/yaml-min.ts",
    });
    expect(await realpath(Bun.resolveSync("@lando/paths", repoRoot))).toBe(
      await realpath(join(pathsRoot, "src/paths.ts")),
    );
  });

  test("resolves from a packed package install", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lando-core-paths-export-"));

    try {
      const packedCore = await packWorkspacePackage({
        label: "core",
        sourceRoot: coreRoot,
        tempDir,
        extractPaths: ["package/package.json", "package/src/config"],
      });
      const packedPaths = await packWorkspacePackage({
        label: "paths",
        sourceRoot: pathsRoot,
        tempDir,
        extractPaths: ["package/package.json", "package/src"],
      });

      await expectArchiveContains(packedCore.archivePath, tempDir, [
        "package/package.json",
        "package/src/config/paths.ts",
      ]);
      await expectArchiveContains(packedPaths.archivePath, tempDir, [
        "package/package.json",
        "package/src/paths.ts",
        "package/src/paths-platform.ts",
        "package/src/overlay.ts",
        "package/src/yaml-min.ts",
      ]);

      const consumerDir = join(tempDir, "consumer");
      const scopedDir = join(consumerDir, "node_modules/@lando");
      await mkdir(scopedDir, { recursive: true });
      // Real installs extract packages into node_modules as plain directories.
      // A symlink would make Bun resolve @lando/paths from the symlink target's
      // realpath, which escapes the consumer's node_modules tree.
      await rename(join(packedCore.extractDir, "package"), join(scopedDir, "core"));
      await rename(join(packedPaths.extractDir, "package"), join(scopedDir, "paths"));

      const probe = [
        "const mod = await import('@lando/core/paths');",
        "const names = ['resolveLandoRoots', 'makeLandoPaths', 'normalizeHostPlatform'];",
        "const missing = names.filter((name) => typeof mod[name] !== 'function');",
        "const ledger = mod.makeLandoPaths({ userDataRoot: '/tmp/lando-data' }).managedFileLedger('app-one');",
        "console.log(JSON.stringify(missing));",
        "console.log(ledger);",
        "console.log(Bun.resolveSync('@lando/core/paths', process.cwd()));",
        "console.log(Bun.resolveSync('@lando/paths', process.cwd()));",
        "process.exit(missing.length === 0 && ledger === '/tmp/lando-data/managed-files/app-one/ledger.json' ? 0 : 1);",
      ].join("");

      const resolved = await runCommand([process.execPath, "-e", probe], consumerDir);
      assertCommandSucceeded("packed @lando/core/paths import", resolved);
      expect(resolved.stderr).toBe("");

      const lines = resolved.stdout.trimEnd().split("\n");
      expect(JSON.parse(lines[0] ?? "[]")).toEqual([]);
      expect(lines[1]).toBe("/tmp/lando-data/managed-files/app-one/ledger.json");
      const [resolvedShim, resolvedImplementation] = lines.slice(2);
      if (resolvedShim === undefined || resolvedImplementation === undefined) {
        throw new Error("packed @lando/core/paths import did not print both resolved paths");
      }
      expect(await realpath(resolvedShim)).toBe(await realpath(join(scopedDir, "core/src/config/paths.ts")));
      expect(await realpath(resolvedImplementation)).toBe(
        await realpath(join(scopedDir, "paths/src/paths.ts")),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 90_000);
});
