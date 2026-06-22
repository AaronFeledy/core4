import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(import.meta.dirname, "../..");
const sdkRoot = resolve(repoRoot, "sdk");
const externalDependencyRoot = resolve(repoRoot, "node_modules");
const packedConsumerDependencies = ["effect", "fast-check", "pure-rand"] as const;

const APP_HANDLE_EXPORTS = ["resolveApp", "openLandoRuntime", "makeLandoRuntime", "AppResolveError"] as const;

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

describe("@lando/core App-handle entry export", () => {
  test("resolves resolveApp and openLandoRuntime from the workspace package", async () => {
    const mod = (await import("@lando/core")) as Record<string, unknown>;

    for (const name of APP_HANDLE_EXPORTS) {
      expect(mod[name], `@lando/core must export "${name}"`).toBeDefined();
    }
    expect(mod.resolveApp).toBeFunction();
    expect(mod.openLandoRuntime).toBeFunction();
    expect(await realpath(Bun.resolveSync("@lando/core", repoRoot))).toBe(
      await realpath(join(coreRoot, "src/index.ts")),
    );
  });

  test("resolves resolveApp and openLandoRuntime from a packed package install", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lando-core-app-handle-export-"));

    try {
      const archivePath = join(tempDir, "lando-core-app-handle.tgz");
      const pack = await runCommand(
        [process.execPath, "pm", "pack", "--filename", archivePath, "--ignore-scripts", "--quiet"],
        coreRoot,
      );
      assertCommandSucceeded("bun pm pack", pack);

      const extractDir = join(tempDir, "extract");
      await mkdir(extractDir);
      const extract = await runCommand(
        ["tar", "-xzf", archivePath, "-C", extractDir, "package/package.json", "package/src"],
        tempDir,
      );
      assertCommandSucceeded("tar extract", extract);

      const consumerDir = join(tempDir, "consumer");
      const scopedDir = join(consumerDir, "node_modules/@lando");
      await mkdir(scopedDir, { recursive: true });
      await symlink(join(extractDir, "package"), join(scopedDir, "core"), "dir");
      await symlink(sdkRoot, join(scopedDir, "sdk"), "dir");

      // The packed default entry statically loads the bundled plugins, so the
      // packed package resolves its dependency closure (workspace @lando/* +
      // npm deps) from the repo node_modules, exactly as an installed consumer
      // would resolve them.
      await symlink(externalDependencyRoot, join(extractDir, "package", "node_modules"), "dir");

      for (const dependency of packedConsumerDependencies) {
        await symlink(
          join(externalDependencyRoot, dependency),
          join(consumerDir, "node_modules", dependency),
          "dir",
        );
      }

      const probe = [
        "const mod = await import('@lando/core');",
        `const names = ${JSON.stringify(APP_HANDLE_EXPORTS)};`,
        "const missing = names.filter((name) => typeof mod[name] !== 'function' && mod[name] === undefined);",
        "const notFn = ['resolveApp', 'openLandoRuntime'].filter((name) => typeof mod[name] !== 'function');",
        "console.log(JSON.stringify(missing));",
        "console.log(JSON.stringify(notFn));",
        "console.log(Bun.resolveSync('@lando/core', process.cwd()));",
        "process.exit(missing.length === 0 && notFn.length === 0 ? 0 : 1);",
      ].join("");

      const resolved = await runCommand([process.execPath, "-e", probe], consumerDir);
      assertCommandSucceeded("packed @lando/core App-handle import", resolved);
      expect(resolved.stderr).toBe("");

      const lines = resolved.stdout.trimEnd().split("\n");
      expect(JSON.parse(lines[0] ?? "[]")).toEqual([]);
      expect(JSON.parse(lines[1] ?? "[]")).toEqual([]);
      const resolvedPath = lines.at(-1);
      if (resolvedPath === undefined) throw new Error("packed import did not print a path");
      expect(await realpath(resolvedPath)).toBe(await realpath(join(extractDir, "package/src/index.ts")));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
