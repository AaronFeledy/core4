import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import corePackage from "../../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(import.meta.dirname, "../..");

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

describe("@lando/core/paths package export", () => {
  test("resolves from the workspace package name", async () => {
    const paths = (await import("@lando/core/paths")) as Record<string, unknown>;

    expect(paths.resolveLandoRoots).toBeFunction();
    expect(paths.makeLandoPaths).toBeFunction();
    expect(paths.normalizeHostPlatform).toBeFunction();
    expect(corePackage.exports["./paths"]).toEqual({
      types: "./src/config/paths.ts",
      import: "./src/config/paths.ts",
    });
    expect(await realpath(Bun.resolveSync("@lando/core/paths", repoRoot))).toBe(
      await realpath(join(coreRoot, "src/config/paths.ts")),
    );
  });

  test("resolves from a packed package install", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lando-core-paths-export-"));

    try {
      const archivePath = join(tempDir, "lando-core-paths.tgz");
      const pack = await runCommand(
        [process.execPath, "pm", "pack", "--filename", archivePath, "--ignore-scripts", "--quiet"],
        coreRoot,
      );
      assertCommandSucceeded("bun pm pack", pack);

      const list = await runCommand(
        [
          "tar",
          "-tzf",
          archivePath,
          "package/package.json",
          "package/src/config/paths.ts",
          "package/src/config/overlay.ts",
          "package/src/config/yaml-min.ts",
        ],
        tempDir,
      );
      assertCommandSucceeded("tar list", list);
      expect(list.stdout).toContain("package/package.json");
      expect(list.stdout).toContain("package/src/config/paths.ts");
      expect(list.stdout).toContain("package/src/config/overlay.ts");
      expect(list.stdout).toContain("package/src/config/yaml-min.ts");

      const extractDir = join(tempDir, "extract");
      await mkdir(extractDir);
      const extract = await runCommand(
        ["tar", "-xzf", archivePath, "-C", extractDir, "package/package.json", "package/src/config"],
        tempDir,
      );
      assertCommandSucceeded("tar extract", extract);

      const consumerDir = join(tempDir, "consumer");
      const scopedDir = join(consumerDir, "node_modules/@lando");
      await mkdir(scopedDir, { recursive: true });
      await symlink(join(extractDir, "package"), join(scopedDir, "core"), "dir");

      const probe = [
        "const mod = await import('@lando/core/paths');",
        "const names = ['resolveLandoRoots', 'makeLandoPaths', 'normalizeHostPlatform'];",
        "const missing = names.filter((name) => typeof mod[name] !== 'function');",
        "console.log(JSON.stringify(missing));",
        "console.log(Bun.resolveSync('@lando/core/paths', process.cwd()));",
        "process.exit(missing.length === 0 ? 0 : 1);",
      ].join("");

      const resolved = await runCommand([process.execPath, "-e", probe], consumerDir);
      assertCommandSucceeded("packed @lando/core/paths import", resolved);
      expect(resolved.stderr).toBe("");

      const lines = resolved.stdout.trimEnd().split("\n");
      expect(JSON.parse(lines[0] ?? "[]")).toEqual([]);
      const resolvedPath = lines.at(-1);
      if (resolvedPath === undefined) throw new Error("packed @lando/core/paths import did not print a path");
      expect(await realpath(resolvedPath)).toBe(
        await realpath(join(extractDir, "package/src/config/paths.ts")),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
