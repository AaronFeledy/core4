import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import corePackage from "../../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(import.meta.dirname, "../..");
const sdkRoot = resolve(repoRoot, "sdk");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({ cmd: [...cmd], cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

describe("@lando/core/testing package export", () => {
  test("resolves from the workspace package name", async () => {
    const testing = await import("@lando/core/testing");

    expect(testing.TestRuntimeProvider.id).toBe("test");
    expect(testing.makeTestRuntime).toBeFunction();
    expect(testing.provideTestRuntime).toBeFunction();
    expect(testing.withService).toBeFunction();
    expect(corePackage.exports["./testing"]).toBe("./src/testing/index.ts");
    expect(Bun.resolveSync("@lando/core/testing", repoRoot)).toBe(join(coreRoot, "src/testing/index.ts"));
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

      const list = await runCommand(["tar", "-tzf", archivePath], tempDir);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("package/package.json");
      expect(list.stdout).toContain("package/src/testing/index.ts");

      const extractDir = join(tempDir, "extract");
      await mkdir(extractDir);
      const extract = await runCommand(["tar", "-xzf", archivePath, "-C", extractDir], tempDir);
      expect(extract.exitCode).toBe(0);

      const consumerDir = join(tempDir, "consumer");
      const scopedDir = join(consumerDir, "node_modules/@lando");
      await mkdir(scopedDir, { recursive: true });
      await symlink(join(extractDir, "package"), join(scopedDir, "core"), "dir");
      await symlink(sdkRoot, join(scopedDir, "sdk"), "dir");

      const resolved = await runCommand(
        [
          process.execPath,
          "-e",
          "const mod = await import('@lando/core/testing'); console.log(mod.TestRuntimeProvider.id); console.log(Bun.resolveSync('@lando/core/testing', process.cwd()));",
        ],
        consumerDir,
      );

      expect(resolved.exitCode).toBe(0);
      expect(resolved.stderr).toBe("");
      expect(resolved.stdout).toContain("test\n");
      expect(resolved.stdout).toContain(join(extractDir, "package/src/testing/index.ts"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
