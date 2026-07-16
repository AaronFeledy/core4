import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { isMvpCommandId } from "../../src/cli/oclif/command-base.ts";
import compiledCommands from "../../src/cli/oclif/compiled-commands.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (args: ReadonlyArray<string>): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repoRoot,
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

const parseErrorEnvelope = (
  stdout: string,
): { readonly command?: string; readonly error?: { readonly _tag?: string } } | undefined => {
  if (stdout.trim().length === 0) return undefined;
  return JSON.parse(stdout) as { readonly command?: string; readonly error?: { readonly _tag?: string } };
};

const nonMvpCommands = Object.keys(compiledCommands)
  .filter((id) => !isMvpCommandId(id))
  .sort((left, right) => left.localeCompare(right));

type CommandWithArgs = {
  readonly args?: Readonly<Record<string, { readonly required?: boolean }>>;
  readonly flags?: Readonly<Record<string, { readonly required?: boolean }>>;
};

const invocationArgs = (commandId: string): ReadonlyArray<string> => {
  const command = compiledCommands[commandId as keyof typeof compiledCommands] as CommandWithArgs;
  const flags = Object.entries(command.flags ?? {})
    .filter(([, flag]) => flag.required === true)
    .map(([name]) => `--${name}=placeholder`);
  const args = Object.values(command.args ?? {})
    .filter((arg) => arg.required === true)
    .map(() => "placeholder");
  return [...flags, ...args];
};

describe("non-MVP OCLIF commands", () => {
  test("exit with a structured NotImplementedError", async () => {
    expect(nonMvpCommands.length).toBeGreaterThan(0);

    for (const commandId of nonMvpCommands) {
      const result = await runCli([commandId, ...invocationArgs(commandId)]);

      expect(result.exitCode, commandId).not.toBe(0);
      expect(result.stderr, commandId).toContain("NotImplementedError");
      expect(result.stderr, commandId).toContain(`commandId: ${commandId}`);
      expect(result.stderr, commandId).toContain("available");
    }
  }, 120_000);

  test("reject unknown flags before deferred command dispatch", async () => {
    const result = await runCli(["meta:events:follow", "--detect"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("UnknownCliFlagError");
    expect(result.stderr).toContain("commandId: meta:events:follow");
    expect(result.stderr).toContain("Remove the unknown flag");
  });

  test("return structured remediation when invoked with universal format flags", async () => {
    const result = await runCli(["meta:plugin:login", "--format", "json"]);
    const envelope = parseErrorEnvelope(result.stdout);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).not.toBe(0);
    expect(envelope?.error?._tag ?? output).toContain("NotImplementedError");
    expect(envelope?.command ?? output).toContain("meta:plugin:login");
    expect(output).not.toContain("Nonexistent flag");
  }, 60_000);
});
