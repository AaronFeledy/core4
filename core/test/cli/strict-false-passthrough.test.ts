import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { findCommand, flagDefinitionsForCommand } from "../../src/cli/compiled-argv.ts";
import { validateCommandCliFlags } from "../../src/cli/flag-value-validation.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/run.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

const runSourceCli = async (args: ReadonlyArray<string>, cwd = repoRoot) => {
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

describe("strict:false catalog passthrough", () => {
  for (const [command, remediation] of [
    ["ssh", "lando ssh -- echo hi"],
    ["exec", "lando exec [SERVICE] -- <command>"],
    ["run", "lando run -- <command>"],
  ] as const) {
    for (const flag of ["-c", "--image", "-x"]) {
      test(`#2148 ${command} rejects leading ${flag} before app bootstrap`, async () => {
        const cwd = await mkdtemp(resolve(tmpdir(), "lando-2148-"));
        try {
          const result = await runSourceCli([command, "--format", "json", flag, "alpine", "--", "true"], cwd);

          expect(result.exitCode).toBe(2);
          expect(JSON.parse(result.stdout)).toMatchObject({
            ok: false,
            error: { _tag: "UnknownCliFlagError", flag, remediation: expect.stringContaining(remediation) },
          });
          if (command === "ssh") expect(result.stdout).toContain("Lando 3 -c");
          expect(result.stdout).not.toContain("cli-app:");
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }, 30_000);
    }
  }

  test.each([
    ["ssh", ["--", "echo", "hi"], ["echo", "hi"]],
    ["ssh", ["-s", "web", "--", "ls"], ["ls"]],
    ["ssh", ["--", "-c", "echo hi"], ["-c", "echo hi"]],
    ["ssh", ["echo", "-x"], ["echo", "-x"]],
    ["ssh", ["echo", "--user"], ["echo", "--user"]],
    ["exec", ["web", "--", "ls", "-la"], ["web", "ls", "-la"]],
    ["exec", ["--", "ls"], ["ls"]],
    ["exec", ["-u", "root", "web", "--", "id"], ["web", "id"]],
    ["exec", ["web", "ls", "-la"], ["web", "ls", "-la"]],
    ["exec", ["-", "-x"], ["-", "-x"]],
    ["run", ["--", "sh", "-c", "x"], ["sh", "-c", "x"]],
    ["run", ["--keep", "--", "true"], ["true"]],
    ["run", ["true", "-x"], ["true", "-x"]],
  ] satisfies ReadonlyArray<readonly [string, ReadonlyArray<string>, ReadonlyArray<string>]>)(
    "%s accepts command argv %j verbatim with global format flags",
    (command, argv, expected) => {
      const entry = findCommand(command);
      if (entry === undefined) throw new Error(`Missing command ${command}`);
      const [commandId, spec] = entry;
      const args = ["--format", "json", ...argv];

      const error = validateCommandCliFlags({
        commandId,
        argv: args,
        definitions: flagDefinitionsForCommand(spec),
        allowUnknownFlags: spec.strict === false,
        ...(spec.commandArgvRemediation === undefined
          ? {}
          : { commandArgvRemediation: spec.commandArgvRemediation }),
      });
      const input = compiledCommandInputFromArgv(commandId, args);

      expect(error).toBeUndefined();
      expect(input.parsedArgv).toEqual(expected);
      expect(input.resultFormat).toBe("json");
    },
  );

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
