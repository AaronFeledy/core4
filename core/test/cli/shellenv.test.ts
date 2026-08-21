import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { renderPosixShellenv, renderPowerShellShellenv } from "../../src/cli/commands/shellenv.ts";

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
      expect(lines[0]).toStartWith("export LANDO_USER_DATA_ROOT=");
      expect(lines[1]).toBe('export PATH="${LANDO_USER_DATA_ROOT}/bin:${PATH}"');
    }, 120_000);

    test("prints PowerShell shellenv snippets when requested", async () => {
      const build = await runCommand([process.execPath, "run", "build"]);
      expect(build.exitCode).toBe(0);

      const shellenv = await runCommand([binaryPath, "shellenv", "--shell=powershell"]);

      expect(shellenv.exitCode).toBe(0);
      expect(shellenv.stderr).toBe("");
      expect(shellenv.stdout).toContain("$Env:LANDO_USER_DATA_ROOT = ");
      expect(shellenv.stdout).toContain(
        '$Env:PATH = "$($Env:LANDO_USER_DATA_ROOT)/bin$([System.IO.Path]::PathSeparator)$Env:PATH"',
      );
    }, 120_000);
  },
);

describe("shellenv snippet rendering", () => {
  test("escapes POSIX paths with spaces and single quotes", () => {
    expect(renderPosixShellenv("/tmp/Lando User's Data")).toBe(
      "export LANDO_USER_DATA_ROOT='/tmp/Lando User'\"'\"'s Data'\n" +
        'export PATH="${LANDO_USER_DATA_ROOT}/bin:${PATH}"',
    );
  });

  test("escapes PowerShell paths with spaces and single quotes", () => {
    expect(renderPowerShellShellenv("C:/Users/Lando User's Data")).toBe(
      "$Env:LANDO_USER_DATA_ROOT = 'C:/Users/Lando User''s Data'\n" +
        '$Env:PATH = "$($Env:LANDO_USER_DATA_ROOT)/bin$([System.IO.Path]::PathSeparator)$Env:PATH"',
    );
  });
});
