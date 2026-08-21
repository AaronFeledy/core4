import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  defaultPosixShellProfilePath,
  renderPosixShellenv,
  renderPowerShellShellenv,
  shellProfileInstallCommand,
} from "../../src/cli/commands/shellenv.ts";

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

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
};

describe("shell profile install path", () => {
  test("writes LANDO_SHELL_PROFILE when that env is set", () => {
    expect(
      defaultPosixShellProfilePath({
        LANDO_SHELL_PROFILE: "/tmp/custom-lando.rc",
        HOME: "/home/me",
        SHELL: "/bin/bash",
      }),
    ).toBe("/tmp/custom-lando.rc");

    const previous = process.env.LANDO_SHELL_PROFILE;
    try {
      process.env.LANDO_SHELL_PROFILE = "/tmp/custom-lando.rc";
      expect(shellProfileInstallCommand("/tmp/lando-data").join("\n")).toContain("/tmp/custom-lando.rc");
    } finally {
      restoreEnv("LANDO_SHELL_PROFILE", previous);
    }
  });

  test("falls back to the default POSIX profile when LANDO_SHELL_PROFILE is unset", () => {
    expect(defaultPosixShellProfilePath({ HOME: "/home/me", SHELL: "/bin/bash" })).toBe("/home/me/.bashrc");

    const previous = process.env.LANDO_SHELL_PROFILE;
    const previousHome = process.env.HOME;
    const previousShell = process.env.SHELL;
    try {
      Reflect.deleteProperty(process.env, "LANDO_SHELL_PROFILE");
      process.env.HOME = "/home/me";
      process.env.SHELL = "/bin/bash";
      expect(defaultPosixShellProfilePath()).toBe("/home/me/.bashrc");
      expect(shellProfileInstallCommand("/tmp/lando-data").join("\n")).toContain("/home/me/.bashrc");
    } finally {
      restoreEnv("LANDO_SHELL_PROFILE", previous);
      restoreEnv("HOME", previousHome);
      restoreEnv("SHELL", previousShell);
    }
  });
});
