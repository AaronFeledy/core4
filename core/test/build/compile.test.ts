import { stat } from "node:fs/promises";
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

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("compiled Linux x64 binary", () => {
  test("builds an executable lando binary with version and help fast paths", async () => {
    const build = await runCommand([process.execPath, "run", "build"]);
    expect(build.exitCode).toBe(0);

    const binary = await stat(binaryPath);
    expect(binary.isFile()).toBe(true);
    expect(binary.mode & 0o111).not.toBe(0);

    const version = await runCommand([binaryPath, "--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(corePackage.version);
    expect(version.stderr).toBe("");

    const help = await runCommand([binaryPath, "--help"]);
    expect(help.exitCode).toBe(0);
    // OCLIF help must actually register commands and topics — a silent exit-0
    // means the binary skipped OCLIF entirely (regression guard for the
    // compile entry-point: must be `bin/lando.ts`, not `src/cli/index.ts`).
    expect(help.stdout).toContain("USAGE");
    expect(help.stdout).toContain("TOPICS");
    expect(help.stdout).toContain("COMMANDS");
  });
});
