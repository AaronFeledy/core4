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
      expect(result.stderr, commandId).toContain("spec/");
      expect(result.stderr, commandId).toContain("See ");
    }
  }, 120_000);

  test("return structured remediation even when invoked with unknown flags", async () => {
    const probes: ReadonlyArray<{ readonly args: ReadonlyArray<string>; readonly commandId: string }> = [
      { args: ["app:config:translate", "--detect"], commandId: "app:config:translate" },
      { args: ["meta:global:list", "--check"], commandId: "meta:global:list" },
      { args: ["meta:recipes:list", "--format", "json"], commandId: "meta:recipes:list" },
    ];

    for (const probe of probes) {
      const result = await runCli(probe.args);

      expect(result.exitCode, probe.commandId).not.toBe(0);
      expect(result.stderr, probe.commandId).toContain("NotImplementedError");
      expect(result.stderr, probe.commandId).toContain(`commandId: ${probe.commandId}`);
      expect(result.stderr, probe.commandId).not.toContain("Nonexistent flag");
    }
  }, 60_000);
});
