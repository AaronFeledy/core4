import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const coreRoot = resolve(import.meta.dirname, "../..");
const binaryDir = resolve(coreRoot, "dist");
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
  "compiled CLI shellenv command",
  () => {
    test("prints shell integration lines before runtime bootstrap", async () => {
      const build = await runCommand([process.execPath, "run", "build"]);
      expect(build.exitCode).toBe(0);

      const shellenv = await runCommand([binaryPath, "shellenv"]);
      const lines = shellenv.stdout.trim().split("\n");

      expect(shellenv.exitCode).toBe(0);
      expect(shellenv.stderr).toBe("");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(`export LANDO_INSTALL_DIR="${binaryDir}"`);
      expect(lines[1]).toBe('export PATH="${LANDO_INSTALL_DIR}/bin:${PATH}"');
    }, 120_000);
  },
);
