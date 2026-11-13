import { describe, expect, test } from "bun:test";
import { NotImplementedError } from "@lando/sdk/errors";
import { commandTailIndex } from "../../src/cli/command-tail.ts";
import { extractFormatFlags, resolveJsonControl, resolveResultFormat } from "../../src/cli/format-flags.ts";
import { type TailPolicy, resolveInvocationHead, splitInvocation } from "../../src/cli/invocation.ts";
import { resolveLogLevel } from "../../src/cli/log-level-selection.ts";
import { resolveRendererMode } from "../../src/cli/renderer-selection.ts";
import { resolveTrace } from "../../src/cli/trace-selection.ts";

const split = (argv: ReadonlyArray<string>, policy: TailPolicy = { kind: "none" }) => {
  const head = resolveInvocationHead(argv);
  return splitInvocation(argv, head, policy);
};

const commandPolicy = (
  flags: Readonly<Record<string, unknown>> = {},
): Extract<TailPolicy, { readonly kind: "command" }> => ({ kind: "command", flags });

const execFlags = {
  service: { type: "option", char: "s" },
  user: { type: "option", char: "u" },
  cwd: { type: "option" },
  interactive: { type: "boolean", char: "i" },
};

const toolingFlags = (
  flags: ReadonlyArray<{ readonly name: string; readonly alias?: string; readonly boolean?: boolean }>,
) =>
  flags.map((flag) => ({
    boolean: false,
    required: false,
    sensitive: false as const,
    ...flag,
  }));

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
    test(`strips ${JSON.stringify(tokens)}`, () => {
      const result = split(["info", ...tokens]);
      expect(result.argv).toEqual(["info"]);
      expect(result.globals).toEqual([...tokens]);
      expect(result.tailLength).toBe(0);
    });
  }

  test.each([
    { tokens: ["--verbose=true"] },
    { tokens: ["--tail=5"] },
    { tokens: ["--tail", "5"] },
    { tokens: ["--debug=false"] },
  ] as const)("leaves $tokens to the command", ({ tokens }) => {
    const result = split(["info", ...tokens]);
    expect(result.argv).toEqual(["info", ...tokens]);
    expect(result.globals).toEqual([]);
  });

  test.each([{ token: "--help" }, { token: "-h" }, { token: "--version" }, { token: "-v" }] as const)(
    "keeps $token in argv for the help and version logic",
    ({ token }) => {
      const result = split(["info", token]);
      expect(result.argv).toEqual(["info", token]);
      expect(result.globals).toEqual([]);
    },
  );
});

describe("splitInvocation", () => {
  test("the first -- ends Lando reading, including as the first token", () => {
    const result = split(["--", "--format=json"]);
    expect(result.globals).toEqual([]);
    expect(result.argv).toEqual(["--", "--format=json"]);
  });

  test("a bare - stays a positional", () => {
    const result = split(["-", "--format=json"]);
    expect(result.argv).toEqual(["-"]);
    expect(result.globals).toEqual(["--format=json"]);
  });

  test("a declared non-boolean flag owns its space value and a lone - value", () => {
    const policy: TailPolicy = {
      kind: "declared",
      flags: toolingFlags([{ name: "env", alias: "e" }, { name: "path" }]),
    };
    const result = split(["deploy", "--env", "prod", "-e", "dev", "--path", "-"], policy);
    expect(result.globals).toEqual([]);
    expect(result.argv).toEqual(["deploy", "--env", "prod", "-e", "dev", "--path", "-"]);
    expect(result.tailLength).toBe(0);
  });

  test("a declared value flag keeps a flag-shaped neighbor instead of borrowing a later token", () => {
    const policy: TailPolicy = { kind: "declared", flags: toolingFlags([{ name: "format" }]) };
    const result = split(["summary", "--format", "--trace", "csv"], policy);
    expect(result.globals).toEqual([]);
    expect(result.argv).toEqual(["summary", "--format", "--trace", "csv"]);
  });

  test("a declared alias claims a token that spells a Lando flag", () => {
    const policy: TailPolicy = {
      kind: "declared",
      flags: toolingFlags([{ name: "jobs", alias: "j" }]),
    };
    const result = split(["deploy", "-j", "4"], policy);
    expect(result.globals).toEqual([]);
    expect(result.argv).toEqual(["deploy", "-j", "4"]);
  });

  test("declared policy still reads undeclared Lando flags until --", () => {
    const result = split(["deploy", "--format=json", "--", "--format=text"], {
      kind: "declared",
      flags: [],
    });
    expect(result.globals).toEqual(["--format=json"]);
    expect(result.argv).toEqual(["deploy", "--", "--format=text"]);
  });

  test("policy all owns every token after the command name", () => {
    const result = split(["bun", "-e", "x", "--format=csv", "--json", "--jq", "."], {
      kind: "all",
    });
    expect(result.globals).toEqual([]);
    expect(result.argv).toEqual(["bun", "-e", "x", "--format=csv", "--json", "--jq", "."]);
    expect(result.tailLength).toBe(6);
  });

  test("case H: universal output flags stay Lando's before an exec tail", () => {
    const result = split(
      ["exec", "--json", "exitCode,service", "printf", "--help"],
      commandPolicy(execFlags),
    );
    expect(result.globals).toEqual(["--json", "exitCode,service"]);
    expect(result.argv).toEqual(["exec", "printf", "--help"]);
    expect(result.tailLength).toBe(2);
  });

  test("a value-taking command flag owns an adjacent --trace token", () => {
    const result = split(["exec", "--user", "--trace", "ls"], commandPolicy(execFlags));
    expect(result.globals).toEqual([]);
    expect(result.argv).toEqual(["exec", "--user", "--trace", "ls"]);
    expect(result.tailLength).toBe(1);
  });

  test("before a command tail a Lando flag stays Lando's even when the command declares the name", () => {
    const flags = { verbose: { type: "boolean" } };
    const result = split(["fixture:run", "--verbose", "ls"], commandPolicy(flags));
    expect(result.globals).toEqual(["--verbose"]);
    expect(result.argv).toEqual(["fixture:run", "ls"]);
    expect(result.tailLength).toBe(1);
  });

  test("a bundle of short flags hands its last flag's value to the command, not the tail", () => {
    const result = split(["exec", "-is", "web", "--verbose", "ls", "--help"], commandPolicy(execFlags));
    expect(result.globals).toEqual(["--verbose"]);
    expect(result.argv).toEqual(["exec", "-is", "web", "ls", "--help"]);
    expect(result.tailLength).toBe(2);
  });

  test("a plugin command owns its tail from the first positional", () => {
    const result = split(["fixture:run", "ls", "--format=json", "--help"], commandPolicy({}));
    expect(result.globals).toEqual([]);
    expect(result.argv).toEqual(["fixture:run", "ls", "--format=json", "--help"]);
    expect(result.tailLength).toBe(3);
  });

  test.each([
    { argv: ["exec", "--json", "exitCode,service", "printf", "--help"] },
    { argv: ["exec", "--user", "root", "ls", "-la"] },
    { argv: ["exec", "--user", "--trace", "ls"] },
    { argv: ["exec", "-is", "web", "--verbose", "ls"] },
    { argv: ["exec", "-sweb", "ls", "-la"] },
    { argv: ["ssh", "-c", "echo", "hi"] },
    { argv: ["exec", "--help", "ls"] },
    { argv: ["exec", "web", "--", "sh", "-c", "x"] },
  ])("the command policy boundary agrees with commandTailIndex for $argv", ({ argv }) => {
    const policy = commandPolicy(execFlags);
    const result = split(argv, policy);
    const boundary = result.argv.length - result.tailLength;
    expect(boundary).toBe(1 + commandTailIndex(result.argv.slice(1), policy.flags));
  });

  test("help before a command tail stays in argv but does not start it", () => {
    const result = split(["exec", "--help", "ls"], commandPolicy(execFlags));
    expect(result.globals).toEqual([]);
    expect(result.argv).toEqual(["exec", "--help", "ls"]);
    expect(result.tailLength).toBe(1);
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
    expect(result.argv).toEqual(["apps:scratch:run", "ls"]);
    expect(result.tailLength).toBe(1);
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
  const chain = (argv: ReadonlyArray<string>, policy: TailPolicy = { kind: "none" }) => {
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
    const result = chain(["build", "--verbose"], {
      kind: "declared",
      flags: toolingFlags([{ name: "verbose", boolean: true }]),
    });
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
    expect(() =>
      chain(["deploy", "--log-level", "--env", "prod"], {
        kind: "declared",
        flags: toolingFlags([{ name: "env" }]),
      }),
    ).toThrow(expect.objectContaining({ _tag: "LogLevelSelectionError", source: "flag", value: "" }));
  });

  test("a deferred renderer flag in a none-policy command still reaches selection", () => {
    expect(() => chain(["logs", "--tail"])).toThrow(NotImplementedError);
  });
});
