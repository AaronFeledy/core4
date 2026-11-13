import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { commandSpecForId, flagDefinitionsForCommand } from "../../src/cli/compiled-argv.ts";
import { setActiveRendererMode, setActiveResultFormat } from "../../src/cli/compiled-runtime.ts";
import { nonePolicy, specOwnerPolicy } from "../../src/cli/flag-claims.ts";
import { resolveResultFormat } from "../../src/cli/format-flags.ts";
import { splitCommandTokens } from "../../src/cli/invocation.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/run.ts";
import { lastEnvelope as envelopeOf } from "./subprocess-support";

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
  test.each([
    { argv: ["web", "-c", "echo hi"], separated: false },
    { argv: ["web", "--", "-tool"], separated: true },
    { argv: ["-s", "web", "--", "-tool"], separated: true },
  ])("retains only the explicit exec separator in $argv", ({ argv, separated }) => {
    const input = compiledCommandInputFromArgv("app:exec", argv);

    expect(input.argv.includes("--")).toBe(separated);
  });

  test.each([
    ["app:ssh", ["--", "sh", "-c", "echo hi"], ["sh", "-c", "echo hi"]],
    ["app:ssh", ["ls", "-la"], ["ls", "-la"]],
    ["app:ssh", ["sh", "-u"], ["sh", "-u"]],
    ["app:exec", ["--", "ls", "-la"], ["ls", "-la"]],
    ["app:exec", ["web", "--", "sh", "-c", "x"], ["web", "sh", "-c", "x"]],
    ["app:exec", ["web", "--user", "root", "--", "id"], ["web", "id"]],
    ["app:ssh", ["ls", "--", "-la"], ["ls", "-la"]],
    ["apps:scratch:run", ["--", "composer", "--version"], ["composer", "--version"]],
    [
      "apps:scratch:run",
      ["--from", "lamp", "composer", "install", "--no-dev"],
      ["composer", "install", "--no-dev"],
    ],
  ])("%s retains command argv for %j", (commandId, argv, expected) => {
    expect(compiledCommandInputFromArgv(commandId, argv).parsedArgv).toEqual(expected);
  });

  const lastEnvelope = (stdout: string) => {
    const lines = stdout.trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1] ?? "{}");
    // Streaming commands end with a result frame that wraps the envelope.
    return last._tag === "result" ? last.envelope : last;
  };

  test.each([
    ["exec ls --help", ["--format=json", "exec", "ls", "--help"], "app:exec"],
    ["ssh ls --version", ["--format=json", "ssh", "ls", "--version"], "app:ssh"],
    ["exec --format json -- ls --help", ["exec", "--format", "json", "--", "ls", "--help"], "app:exec"],
  ])("Lando flags inside the command tail of %s belong to the command", async (_name, argv, commandId) => {
    const result = await runSourceCli(argv);
    // The command ran (and failed outside an app) instead of printing Lando help or version.
    expect(lastEnvelope(result.stdout)).toMatchObject({ command: commandId, ok: false });
  });

  test.each([
    ["exec", "--help"],
    ["run", "--help"],
  ])("%s %s before any command word still prints Lando help", async (command, flag) => {
    const result = await runSourceCli([command, flag]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });

  test("a bare --json before the command word still lists result keys", async () => {
    const result = await runSourceCli(["exec", "--json", "echo"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toContain("exitCode");
  });

  test.each([
    ["ssh", "-c"],
    ["exec", "-c"],
    ["run", "--image"],
    ["app:includes:update", "--no-netwrok"],
  ])("%s rejects unknown prefix flag %s before its lifecycle", async (command, flag) => {
    const result = await runSourceCli([command, flag, "--format=json"]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ ok: false, error: { _tag: "UnknownCliFlagError", flag } });
  });
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

test.each([
  ["scratch run", ["--format=json", "scratch", "run", "ls", "--help"]],
  ["--renderer=plain scratch run", ["--format=json", "--renderer=plain", "scratch", "run", "ls", "--help"]],
  ["scratch --renderer=plain run", ["--format=json", "scratch", "--renderer=plain", "run", "ls", "--help"]],
])(
  "%s routes trailing --help to scratch execution",
  async (_name, argv) => {
    const result = await runSourceCli(argv);
    expect(envelopeOf(result.stdout)).toMatchObject({ command: "apps:scratch:run", ok: false });
  },
  30_000,
);

test("exec accepts a --json projection before its command tail and reaches the missing-app error", async () => {
  const result = await runSourceCli([
    "--format=json",
    "exec",
    "--json",
    "exitCode,service",
    "printf",
    "--help",
  ]);
  expect(envelopeOf(result.stdout)).toMatchObject({
    command: "app:exec",
    ok: false,
    error: { _tag: "ToolingExecError" },
  });
}, 30_000);

describe("declared value slots beat Lando spellings", () => {
  test.each([
    { argv: ["--format=json", "exec", "--user", "--help", "ls"], flag: "user" },
    { argv: ["--format=json", "exec", "--user", "--trace", "ls"], flag: "user" },
  ])("a declared value flag owns $flag's flag-shaped neighbor", async ({ argv, flag }) => {
    // When
    const result = await runSourceCli(argv);

    // Then
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "MalformedCliFlagValueError", flag, issue: "missing" },
    });
  });

  test.each([
    { argv: ["--format=json", "logs", "--tail"], flag: "tail" },
    { argv: ["--format=json", "logs", "--tail", "--verbose"], flag: "tail" },
    { argv: ["--format=json", "logs", "--service", "--verbose"], flag: "service" },
  ])("$argv is a command value-slot error, not the deferred tail flag", async ({ argv, flag }) => {
    // When
    const result = await runSourceCli(argv);

    // Then
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      ok: false,
      error: { _tag: "MalformedCliFlagValueError", flag, issue: "missing" },
    });
    expect(envelope.error._tag).not.toBe("NotImplementedError");
  });

  test("logs --tail -5 reads -5 as the tail value", async () => {
    // When
    const result = await runSourceCli(["--format=json", "logs", "--tail", "-5"]);

    // Then — outside an app the command fails later, never at the tail flag
    const envelope = envelopeOf(result.stdout);
    expect(envelope).toMatchObject({ command: "app:logs" });
    expect(envelope).not.toMatchObject({
      error: { _tag: "MalformedCliFlagValueError", flag: "tail" },
    });
  });
});

describe("dispatcher tokens and standalone input agree", () => {
  const viaTokens = (commandId: string, argv: ReadonlyArray<string>) => {
    const spec = commandSpecForId(commandId);
    const definitions = spec === undefined ? {} : flagDefinitionsForCommand(spec);
    const policy = spec === undefined ? nonePolicy(true) : specOwnerPolicy(spec, definitions);
    const split = splitCommandTokens(argv, policy, "output");
    const resolved = resolveResultFormat({ argv: split.globals, rendererMode: "lando" });
    return compiledCommandInputFromArgv(commandId, argv, {
      tokens: split.command,
      resultFormat: resolved.format,
    });
  };

  const comparable = (input: ReturnType<typeof compiledCommandInputFromArgv>) => ({
    argv: input.argv,
    ...(input.parsedArgv === undefined ? {} : { parsedArgv: input.parsedArgv }),
    flags: input.flags,
    args: input.args,
  });

  test.each([
    ["app:exec", ["--user", "www-data", "--", "echo", "-n", "hi"]],
    ["app:exec", ["web", "-c", "echo hi"]],
    ["app:ssh", ["-c", "echo", "hi"]],
    ["apps:scratch:run", ["--from", "lamp", "composer", "install", "--no-dev"]],
    ["meta:bun", ["-e", "console.log(1)"]],
    ["meta:x", ["prettier", "--check", "."]],
    ["app:info", ["--format", "json", "--service", "api"]],
  ])("%s produces the same input with and without dispatcher tokens for %j", (commandId, argv) => {
    // Given a clean selection state
    setActiveResultFormat("text");
    setActiveRendererMode("lando");

    // When the standalone and dispatcher paths each build the input
    const standalone = comparable(compiledCommandInputFromArgv(commandId, argv));
    const dispatched = comparable(viaTokens(commandId, argv));

    // Then every consumer-visible field agrees
    expect(dispatched).toEqual(standalone);
  });
});
