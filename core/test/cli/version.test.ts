import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import corePackage from "../../package.json";

const coreRoot = resolve(import.meta.dirname, "../..");
const binaryPath = resolve(coreRoot, "dist/lando");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: Array<string>, cwd = coreRoot): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd,
    cwd,
    env: {
      ...process.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "compiled CLI version command",
  () => {
    test("prints the core package version before runtime bootstrap", async () => {
      const build = await runCommand([process.execPath, "run", "build"]);
      expect(build.exitCode).toBe(0);

      const version = await runCommand([binaryPath, "version"]);

      expect(version.exitCode).toBe(0);
      expect(version.stdout.trim()).toBe(corePackage.version);
      expect(version.stderr).toBe("");
    }, 120_000);
  },
);
