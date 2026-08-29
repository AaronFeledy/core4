import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { resolveBuiltInCommand } from "../../src/cli/built-in-command-registry.ts";
import { sshSpec } from "../../src/cli/command-specs/app/ssh.ts";
import { resolveTopLevelAliases } from "../../src/cli/spec/command-spec.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (args: ReadonlyArray<string>, cwd = repoRoot): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
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

describe("lando ssh — provider-exec TTY command behavior", () => {
  test("registers `ssh` and `app:ssh` as a top-level alias and native id", () => {
    expect(resolveTopLevelAliases(resolveBuiltInCommand("app:ssh")?.spec ?? sshSpec)).toContain("ssh");
    expect(resolveTopLevelAliases(sshSpec)).toContain("ssh");
  });

  test("`--subsystem` fails with a structured NotImplementedError (defer)", async () => {
    const result = await runCli(["ssh", "--subsystem=sftp"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("NotImplementedError");
    expect(result.stderr).toContain("commandId: app:ssh");
    expect(result.stderr).toContain("subsystem");
    expect(result.stderr).toContain("not supported");
    expect(result.stderr).not.toMatch(/\bAlpha\b/);
    expect(result.stderr).not.toMatch(/\bBeta\b/);
  });

  test("`--sidecar` fails with a structured NotImplementedError (defer)", async () => {
    const result = await runCli(["ssh", "--sidecar"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("NotImplementedError");
    expect(result.stderr).toContain("commandId: app:ssh");
    expect(result.stderr).toContain("sidecar");
    expect(result.stderr).toContain("not supported");
    expect(result.stderr).not.toMatch(/\bAlpha\b/);
    expect(result.stderr).not.toMatch(/\bBeta\b/);
  });

  test("flag descriptions are phase-neutral current-state wording", () => {
    const flags = JSON.stringify(sshSpec.flags);
    expect(flags).toContain("not supported");
    expect(flags).not.toMatch(/\bAlpha\b/);
    expect(flags).not.toMatch(/\bBeta\b/);
  });
});
