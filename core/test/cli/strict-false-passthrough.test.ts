import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { compiledCommandInputFromArgv } from "../../src/cli/run.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

const runSourceCli = async (args: ReadonlyArray<string>) => {
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

describe("strict:false catalog passthrough", () => {
  for (const { commandId, argv, flagName, flagValue, parsedArgv } of [
    {
      commandId: "app:exec",
      argv: ["--user", "www-data", "printf", "-s", "inner"],
      flagName: "user",
      flagValue: "www-data",
      parsedArgv: ["printf", "-s", "inner"],
    },
    {
      commandId: "app:ssh",
      argv: ["--user", "www-data", "env", "-u", "inner"],
      flagName: "user",
      flagValue: "www-data",
      parsedArgv: ["env", "-u", "inner"],
    },
  ]) {
    test(`${commandId} preserves declared flags after command argv as passthrough`, () => {
      const input = compiledCommandInputFromArgv(commandId, argv);

      expect(input.flags[flagName]).toBe(flagValue);
      expect(input.parsedArgv).toEqual(parsedArgv);
    });
  }

  test("command passthrough preserves universal and packed flags after the command", () => {
    const input = compiledCommandInputFromArgv("app:exec", [
      "--format=json",
      "printf",
      "--format=text",
      "-su",
    ]);

    expect(input.resultFormat).toBe("json");
    expect(input.parsedArgv).toEqual(["printf", "--format=text", "-su"]);
  });

  test("meta:bun forwards extra argv instead of rejecting it as unexpected", async () => {
    const result = await runSourceCli(["bun", "-e", "console.log('us583-bun-ok')"]);
    expect(result.stderr).not.toContain("Unexpected argument");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("us583-bun-ok");
  }, 30_000);
});
