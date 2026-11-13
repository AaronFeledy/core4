import { describe, expect, test } from "bun:test";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { NotImplementedError } from "@lando/sdk/errors";
import type { ToolingInputDeclaration } from "@lando/sdk/schema";
import { Result } from "effect";
import { specOwnerPolicy, toolingFlagClaims } from "../../src/cli/flag-claims.ts";
import { extractFormatFlags, resolveJsonControl, resolveResultFormat } from "../../src/cli/format-flags.ts";
import {
  type OwnerPolicy,
  resolveInvocationHead,
  splitCommandTokens,
  splitInvocation,
} from "../../src/cli/invocation.ts";
import { resolveLogLevel } from "../../src/cli/log-level-selection.ts";
import { resolveRendererMode } from "../../src/cli/renderer-selection.ts";
import { resolveTrace } from "../../src/cli/trace-selection.ts";

const noClaims = () => undefined;
const none: OwnerPolicy = { tail: "none", claims: noClaims, reservedOutput: [] };

const split = (argv: ReadonlyArray<string>, policy: OwnerPolicy = none) =>
  splitInvocation(argv, resolveInvocationHead(argv), policy);

const commandPolicy = (flags: Readonly<Record<string, unknown>> = {}, id = "app:exec"): OwnerPolicy =>
  specOwnerPolicy({ id, strict: false, args: { command: {} } }, flags);

const flagsOnlyPolicy = (id: string, flags: Readonly<Record<string, unknown>> = {}): OwnerPolicy =>
  specOwnerPolicy({ id }, flags);

type ToolingFlagSpec = { readonly name: string; readonly alias?: string; readonly boolean?: boolean };

const toolingDeclaration = (specs: ReadonlyArray<ToolingFlagSpec>): ToolingInputDeclaration =>
  Result.getOrThrowWith(
    normalizeToolingInput("test", {
      flags: Object.fromEntries(
        specs.map((spec) => [
          spec.name,
          {
            ...(spec.alias === undefined ? {} : { alias: spec.alias }),
            ...(spec.boolean === undefined ? {} : { boolean: spec.boolean }),
          },
        ]),
      ),
    }),
    (error) => error,
  );

const toolingPolicy = (specs: ReadonlyArray<ToolingFlagSpec> = []): OwnerPolicy => ({
  tail: "none",
  claims: toolingFlagClaims(toolingDeclaration(specs)),
  reservedOutput: [],
});

const execFlags = {
  service: { type: "option", char: "s" },
  user: { type: "option", char: "u" },
  cwd: { type: "option" },
  interactive: { type: "boolean", char: "i" },
};

describe("dispatcher table", () => {
  const accepted: ReadonlyArray<ReadonlyArray<string>> = [
    ["--trace"],
    ["--debug"],
    ["--verbose"],
    ["--no-deprecation-warnings"],
    ["-j"],
    ["--log-level=debug"],
    ["--log-level", "debug"],
    ["--renderer=plain"],
    ["--renderer", "plain"],
    ["--format=json"],
    ["--format", "json"],
    ["--jq=.app"],
    ["--jq", ".app"],
    ["--json"],
    ["--json=a,b"],
    ["--json", "a,b"],
    ["--expand"],
    ["--no-expand"],
    ["--collapse"],
    ["--no-collapse"],
    ["--no-tail"],
    ["--tail"],
  ];

  for (const tokens of accepted) {
    test(`reads ${JSON.stringify(tokens)}`, () => {
      const result = split(["info", ...tokens]);
      expect(result.globals).toEqual([...tokens]);
      expect(result.controls).toEqual([]);
      expect(result.command.argv).toEqual([]);
      expect(result.command.tailStart).toBe(0);
    });
  }

  test.each([
    { tokens: ["--verbose=true"] },
    { tokens: ["--tail=5"] },
    { tokens: ["--tail", "5"] },
    { tokens: ["--debug=false"] },
  ] as const)("leaves $tokens to the command", ({ tokens }) => {
    const result = split(["info", ...tokens]);
    expect(result.globals).toEqual([]);
    expect(result.command.argv).toEqual([...tokens]);
  });

  test.each([{ token: "--help" }, { token: "-h" }, { token: "--version" }, { token: "-v" }] as const)(
    "records $token as a control",
    ({ token }) => {
      const result = split(["info", token]);
      expect(result.globals).toEqual([]);
      expect(result.controls).toEqual([token]);
      expect(result.command.argv).toEqual([]);
      expect(result.help).toBe(token === "--help" || token === "-h");
      expect(result.version).toBe(token === "--version" || token === "-v");
    },
  );

  test("tooling claims keep version and a declared help spelling out of the controls", () => {
    const declared = split(
      ["task", "--help", "-h", "--version", "-v"],
      toolingPolicy([{ name: "help", boolean: true }]),
    );
    expect(declared.controls).toEqual([]);
    expect(declared.command.argv).toEqual(["--help", "-h", "--version", "-v"]);

    const plain = split(["task", "--help", "--version"], toolingPolicy());
    expect(plain.controls).toEqual(["--help"]);
    expect(plain.command.argv).toEqual(["--version"]);
  });

  test("reserved output spellings beat a definition that claims them", () => {
    const policy = commandPolicy({
      format: { type: "option" },
      json: { type: "boolean" },
      j: { type: "boolean", char: "j" },
    });
    const result = split(["fixture:run", "--format=csv", "--json", "-j", "ls"], policy);
    expect(result.globals).toEqual(["--format=csv", "--json", "-j"]);
    expect(result.command.argv).toEqual(["ls"]);
  });
});

describe("splitInvocation", () => {
  test("the first -- ends Lando reading, including as the first token", () => {
    const result = split(["--", "--format=json"]);
    expect(result.globals).toEqual([]);
    expect(result.command.argv).toEqual(["--", "--format=json"]);
    expect(result.command.tailStart).toBe(0);
  });

  test("a bare - is a positional command word, not a Lando flag", () => {
    const result = split(["-", "--format=json"]);
    expect(result.command.argv).toEqual([]);
    expect(result.globals).toEqual(["--format=json"]);
    expect(resolveInvocationHead(["-", "--format=json"]).commandId).toBe("-");
  });

  test("a declared non-boolean flag owns its space value and a lone - value", () => {
    const policy = toolingPolicy([{ name: "env", alias: "e" }, { name: "path" }]);
    const result = split(["deploy", "--env", "prod", "-e", "dev", "--path", "-"], policy);
    expect(result.globals).toEqual([]);
    expect(result.command.argv).toEqual(["--env", "prod", "-e", "dev", "--path", "-"]);
    expect(result.command.tailStart).toBe(result.command.argv.length);
  });

  test("a declared value flag keeps a flag-shaped neighbor as its value slot", () => {
    const result = split(["summary", "--format", "--trace", "csv"], toolingPolicy([{ name: "format" }]));
    expect(result.globals).toEqual([]);
    expect(result.command.argv).toEqual(["--format", "--trace", "csv"]);
  });

  test("a declared alias claims a token that spells a Lando flag", () => {
    const result = split(["deploy", "-j", "4"], toolingPolicy([{ name: "jobs", alias: "j" }]));
    expect(result.globals).toEqual([]);
    expect(result.command.argv).toEqual(["-j", "4"]);
  });

  test("an undeclared Lando flag is still read until --", () => {
    const result = split(["deploy", "--format=json", "--", "--format=text"], toolingPolicy());
    expect(result.globals).toEqual(["--format=json"]);
    expect(result.command.argv).toEqual(["--", "--format=text"]);
    expect(result.command.tailStart).toBe(0);
  });

  test("a command flag declared under a Lando spelling wins before the tail", () => {
    const result = split(["fixture:run", "--verbose", "ls"], commandPolicy({ verbose: { type: "boolean" } }));
    expect(result.globals).toEqual([]);
    expect(result.command.argv).toEqual(["--verbose", "ls"]);
    expect(result.command.tailStart).toBe(1);
  });

  test("policy all owns every token after the command name", () => {
    const result = split(["bun", "-e", "x", "--format=csv", "--json", "--jq", "."], {
      tail: "all",
      claims: noClaims,
      reservedOutput: [],
    });
    expect(result.globals).toEqual([]);
    expect(result.command.argv).toEqual(["-e", "x", "--format=csv", "--json", "--jq", "."]);
    expect(result.command.tailStart).toBe(0);
  });

  test("case H: universal output flags stay Lando's before an exec tail", () => {
    const result = split(
      ["exec", "--json", "exitCode,service", "printf", "--help"],
      commandPolicy(execFlags),
    );
    expect(result.globals).toEqual(["--json", "exitCode,service"]);
    expect(result.command.argv).toEqual(["printf", "--help"]);
    expect(result.command.tailStart).toBe(0);
  });

  test("a value-taking command flag owns an adjacent --trace token", () => {
    const result = split(["exec", "--user", "--trace", "ls"], commandPolicy(execFlags));
    expect(result.globals).toEqual([]);
    expect(result.command.argv).toEqual(["--user", "--trace", "ls"]);
    expect(result.command.tailStart).toBe(2);
  });

  test("a bundle of short flags hands its last flag's value to the command, not the tail", () => {
    const result = split(["exec", "-is", "web", "--verbose", "ls", "--help"], commandPolicy(execFlags));
    expect(result.globals).toEqual(["--verbose"]);
    expect(result.command.argv).toEqual(["-is", "web", "ls", "--help"]);
    expect(result.command.tailStart).toBe(2);
  });

  test("a plugin command owns its tail from the first positional", () => {
    const result = split(["fixture:run", "ls", "--format=json", "--help"], commandPolicy({}));
    expect(result.globals).toEqual([]);
    expect(result.command.argv).toEqual(["ls", "--format=json", "--help"]);
    expect(result.command.tailStart).toBe(0);
  });

  test("a value slot of --help before the tail is never read as Lando's", () => {
    const result = split(["exec", "--user", "--help", "ls"], commandPolicy(execFlags));
    expect(result.globals).toEqual([]);
    expect(result.controls).toEqual([]);
    expect(result.command.argv).toEqual(["--user", "--help", "ls"]);
    expect(result.command.tailStart).toBe(2);
  });

  test("a bare-value flag has no value slot and keeps the next Lando flag Lando's", () => {
    const result = split(["scratch", "--mount-cwd", "--format=json"], flagsOnlyPolicy("apps:scratch:start"));
    expect(result.globals).toEqual(["--format=json"]);
    expect(result.command.argv).toEqual(["--mount-cwd"]);
    expect(result.command.tailStart).toBe(1);
  });

  test.each([
    { argv: ["exec", "--json", "exitCode,service", "printf", "--help"], tailStart: 0 },
    { argv: ["exec", "--user", "root", "ls", "-la"], tailStart: 2 },
    { argv: ["exec", "--user", "--trace", "ls"], tailStart: 2 },
    { argv: ["exec", "-is", "web", "--verbose", "ls"], tailStart: 2 },
    { argv: ["exec", "-sweb", "ls", "-la"], tailStart: 1 },
    { argv: ["ssh", "-c", "echo", "hi"], tailStart: 1 },
    { argv: ["exec", "--help", "ls"], tailStart: 0 },
    { argv: ["exec", "web", "--", "sh", "-c", "x"], tailStart: 1 },
  ])("tailStart follows the command boundary for $argv", ({ argv, tailStart }) => {
    expect(split(argv, commandPolicy(execFlags)).command.tailStart).toBe(tailStart);
  });

  test("help before a command tail stays a control and does not start it", () => {
    const result = split(["exec", "--help", "ls"], commandPolicy(execFlags));
    expect(result.globals).toEqual([]);
    expect(result.controls).toEqual(["--help"]);
    expect(result.command.argv).toEqual(["ls"]);
    expect(result.command.tailStart).toBe(0);
  });

  test("tailStart for a none-tail command is the first --, or the end", () => {
    expect(split(["info", "--path", "demo"]).command.tailStart).toBe(2);
    expect(split(["info", "--", "--format=json"]).command.tailStart).toBe(0);
  });

  test("globalsAfterName is only what Lando read after the command name", () => {
    const interleaved = split(["scratch", "--verbose", "run", "ls"], {
      ...commandPolicy(),
      reservedOutput: [],
    });
    expect(interleaved.globals).toEqual(["--verbose"]);
    expect(interleaved.globalsAfterName).toEqual([]);
    expect(interleaved.command.argv).toEqual(["ls"]);
    expect(interleaved.command.tailStart).toBe(0);

    const afterName = split(["task", "--format=json"], none);
    expect(afterName.globals).toEqual(["--format=json"]);
    expect(afterName.globalsAfterName).toEqual(["--format=json"]);
  });

  test("the walker is stable on the command's own tokens", () => {
    for (const [argv, policy] of [
      [["exec", "--json", "a,b", "printf", "--help"], commandPolicy(execFlags)],
      [["exec", "web", "--", "sh"], commandPolicy(execFlags)],
      [["bun", "-e", "x", "--help"], { tail: "all", claims: noClaims, reservedOutput: [] } as OwnerPolicy],
      [["info", "--json", "a,b", "--renderer=plain"], none],
    ] as const) {
      const result = split(argv, policy);
      const rerun = splitCommandTokens(result.command.argv, policy);
      expect(rerun.globals).toEqual([]);
      expect(rerun.controls).toEqual([]);
      expect(rerun.command.tailStart).toBe(result.command.tailStart);
    }
  });
});

describe("splitCommandTokens scopes", () => {
  test("output reads only result-encoding flags and leaves the rest to the command", () => {
    const result = splitCommandTokens(
      ["--format=json", "-j", "--verbose", "--jq", ".ok", "--help"],
      none,
      "output",
    );
    expect(result.globals).toEqual(["--format=json", "-j", "--jq", ".ok"]);
    expect(result.controls).toEqual([]);
    expect(result.command.argv).toEqual(["--verbose", "--help"]);
  });

  test("none reads no table flag at all", () => {
    const result = splitCommandTokens(["--format=json", "--help", "ls"], none, "none");
    expect(result.globals).toEqual([]);
    expect(result.controls).toEqual([]);
    expect(result.command.argv).toEqual(["--format=json", "--help", "ls"]);
  });

  test("all reads selection and control spellings", () => {
    const result = splitCommandTokens(["--format=json", "--help", "--verbose", "ls"], none, "all");
    expect(result.globals).toEqual(["--format=json", "--verbose"]);
    expect(result.controls).toEqual(["--help"]);
    expect(result.command.argv).toEqual(["ls"]);
  });
});

describe("resolveInvocationHead", () => {
  test.each([
    { argv: ["scratch", "run", "ls"], commandId: "apps:scratch:run", wordIndices: [0, 1] },
    {
      argv: ["--renderer=plain", "scratch", "run", "ls"],
      commandId: "apps:scratch:run",
      wordIndices: [1, 2],
    },
    { argv: ["scratch", "--verbose", "run", "ls"], commandId: "apps:scratch:run", wordIndices: [0, 2] },
    { argv: ["global", "--format=json", "status"], commandId: "global:status", wordIndices: [0, 2] },
    { argv: ["scratch", "--from", "lamp", "run"], commandId: "scratch", wordIndices: [0] },
  ] as const)("resolves $argv to $commandId", ({ argv, commandId, wordIndices }) => {
    const head = resolveInvocationHead(argv);
    expect(head.commandId).toBe(commandId);
    expect(head.commandWordIndices).toEqual(wordIndices);
  });

  test("an interleaved Lando flag is Lando's, not part of the head", () => {
    const result = split(["scratch", "--verbose", "run", "ls"], commandPolicy());
    expect(result.globals).toEqual(["--verbose"]);
    expect(result.command.argv).toEqual(["ls"]);
    expect(result.command.tailStart).toBe(0);
  });

  test.each([
    { lead: "--version", why: "Lando answers version itself" },
    { lead: "--help", why: "Lando answers help itself" },
    { lead: "--future", why: "an unknown flag is not a command" },
    { lead: "--", why: "the separator ends Lando reading" },
  ])("$lead before a command word leaves no owner: $why", ({ lead }) => {
    expect(resolveInvocationHead([lead, "build"]).commandId).toBeUndefined();
  });
});

describe("selection chain over the split", () => {
  const chain = (argv: ReadonlyArray<string>, policy: OwnerPolicy = none) => {
    const { globals } = split(argv, policy);
    const trace = resolveTrace({ argv: globals, env: {} });
    const logLevel = resolveLogLevel({ argv: trace.remainingArgv, env: {} });
    const renderer = resolveRendererMode({ argv: logLevel.remainingArgv, env: {} });
    const extracted = extractFormatFlags(renderer.remainingArgv);
    const format = resolveResultFormat({ argv: renderer.remainingArgv, rendererMode: renderer.mode });
    return {
      globals,
      trace,
      logLevel,
      renderer,
      extracted,
      format,
      json: resolveJsonControl(extracted, format.format),
    };
  };

  test("selects trace, log level, renderer, format, and jq", () => {
    const result = chain([
      "start",
      "--trace",
      "--debug",
      "--renderer=plain",
      "--format=yaml",
      "--jq",
      ".app",
    ]);
    expect(result.trace.display).toBe(true);
    expect(result.logLevel.level).toBe("debug");
    expect(result.renderer.mode).toBe("plain");
    expect(result.format.format).toBe("yaml");
    expect(result.extracted.jq).toBe(".app");
  });

  test("a bare --json lists keys", () => {
    expect(chain(["info", "--json"]).json).toEqual({ mode: "list" });
  });

  test("--json with a field list selects keys", () => {
    expect(chain(["info", "--json", "exitCode,service"]).json).toEqual({
      mode: "keys",
      keys: ["exitCode", "service"],
    });
  });

  test("-j selects the json envelope without a key list", () => {
    const result = chain(["info", "-j"]);
    expect(result.format.format).toBe("json");
    expect(result.json).toEqual({ mode: "off" });
  });

  test("a task flag named verbose is not a Lando log level", () => {
    const result = chain(["build", "--verbose"], toolingPolicy([{ name: "verbose", boolean: true }]));
    expect(result.globals).toEqual([]);
    expect(result.logLevel.level).toBe("none");
    expect(result.logLevel.verbose).toBe(false);
  });

  test("bare --json before a renderer flag lists keys instead of consuming a later field list", () => {
    const result = chain(["info", "--json", "--renderer=plain", "a,b"]);
    expect(result.json).toEqual({ mode: "list" });
  });

  test("adjacency change: --format before a renderer flag is a missing value", () => {
    expect(() => chain(["info", "--format", "--renderer=plain", "json"])).toThrow(
      expect.objectContaining({ _tag: "RendererSelectionError", source: "flag", value: "" }),
    );
  });

  test("adjacency change: --log-level before --trace is a missing value", () => {
    expect(() => chain(["info", "--log-level", "--trace", "debug"])).toThrow(
      expect.objectContaining({ _tag: "LogLevelSelectionError", source: "flag", value: "" }),
    );
  });

  test("--log-level before a claimed flag stays a missing-value error", () => {
    expect(() => chain(["deploy", "--log-level", "--env", "prod"], toolingPolicy([{ name: "env" }]))).toThrow(
      expect.objectContaining({ _tag: "LogLevelSelectionError", source: "flag", value: "" }),
    );
  });

  test("a deferred renderer flag in a none-policy command still reaches selection", () => {
    expect(() => chain(["logs", "--tail"])).toThrow(NotImplementedError);
  });
});
