import { describe, expect, test } from "bun:test";

import {
  type ChoicesCommandSpawner,
  ChoicesParseFailure,
  createDefaultChoicesCommandRunner,
  landoInvocationPrefix,
  parseChoicesOutput,
  readStandaloneExecutable,
} from "../../../src/recipes/prompts/choices-command.ts";

describe("parseChoicesOutput — json", () => {
  test("array of scalars decodes to choices", () => {
    expect(parseChoicesOutput('["8.2", "8.3"]', "json")).toEqual(["8.2", "8.3"]);
    expect(parseChoicesOutput("[80, 443]", "json")).toEqual([80, 443]);
  });

  test("array of {value,label} objects decodes", () => {
    const choices = parseChoicesOutput('[{"value":"php","label":"PHP"}]', "json");
    expect(choices).toEqual([{ value: "php", label: "PHP" }]);
  });

  test("invalid json throws unparseable", () => {
    try {
      parseChoicesOutput("not json", "json");
      throw new Error("expected throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ChoicesParseFailure);
      expect((cause as ChoicesParseFailure).kind).toBe("unparseable");
    }
  });

  test("non-array json throws unparseable", () => {
    expect(() => parseChoicesOutput('{"a":1}', "json")).toThrow(ChoicesParseFailure);
  });

  test("entry that is not a choice throws unparseable", () => {
    expect(() => parseChoicesOutput("[[1,2]]", "json")).toThrow(ChoicesParseFailure);
  });

  test("empty array throws empty", () => {
    try {
      parseChoicesOutput("[]", "json");
      throw new Error("expected throw");
    } catch (cause) {
      expect((cause as ChoicesParseFailure).kind).toBe("empty");
    }
  });
});

describe("parseChoicesOutput — lines", () => {
  test("splits, trims, and drops blank lines", () => {
    expect(parseChoicesOutput("8.2\n  8.3 \n\n8.4\n", "lines")).toEqual(["8.2", "8.3", "8.4"]);
  });

  test("all-blank output throws empty", () => {
    try {
      parseChoicesOutput("\n  \n", "lines");
      throw new Error("expected throw");
    } catch (cause) {
      expect((cause as ChoicesParseFailure).kind).toBe("empty");
    }
  });
});

describe("readStandaloneExecutable", () => {
  test("returns the boolean property when present", () => {
    expect(readStandaloneExecutable({ isStandaloneExecutable: true })).toBe(true);
    expect(readStandaloneExecutable({ isStandaloneExecutable: false })).toBe(false);
  });

  test("returns undefined when the property is missing", () => {
    expect(readStandaloneExecutable({})).toBeUndefined();
    expect(readStandaloneExecutable({ isStandaloneExecutable: "yes" })).toBeUndefined();
  });
});

describe("landoInvocationPrefix", () => {
  test("source prefix is [execPath, entry]", () => {
    expect(
      landoInvocationPrefix("/bun", ["/bun", "/repo/core/src/cli/index.ts", "init"], { standalone: false }),
    ).toEqual(["/bun", "/repo/core/src/cli/index.ts"]);
  });

  test("compiled/standalone prefix is [execPath]", () => {
    expect(
      landoInvocationPrefix("/usr/bin/lando", ["/usr/bin/lando", "/repo/core/src/cli/index.ts", "init"], {
        standalone: true,
      }),
    ).toEqual(["/usr/bin/lando"]);
  });

  test("compiled path does not require $bunfs once the standalone API is true", () => {
    expect(
      landoInvocationPrefix("/usr/bin/lando", ["/usr/bin/lando", "/not-bunfs/entry"], { standalone: true }),
    ).toEqual(["/usr/bin/lando"]);
  });

  test("falls back to $bunfs when the standalone property is missing", () => {
    expect(
      landoInvocationPrefix("/usr/bin/lando", ["/usr/bin/lando", "/$bunfs/root/lando", "init"], {
        standalone: undefined,
      }),
    ).toEqual(["/usr/bin/lando"]);
  });

  test("missing entry uses execPath only", () => {
    expect(landoInvocationPrefix("/usr/bin/lando", ["/usr/bin/lando"], { standalone: false })).toEqual([
      "/usr/bin/lando",
    ]);
  });
});

describe("createDefaultChoicesCommandRunner", () => {
  test("builds the re-invocation argv and forwards the spawner result", async () => {
    const calls: Array<{ cmd: ReadonlyArray<string>; cwd: string }> = [];
    const spawner: ChoicesCommandSpawner = {
      spawn: async ({ cmd, cwd }) => {
        calls.push({ cmd, cwd });
        return { exitCode: 0, stdout: "php\n", stderr: "" };
      },
    };
    const runner = createDefaultChoicesCommandRunner({
      spawner,
      execPath: "/usr/bin/lando",
      argv: ["/usr/bin/lando", "/$bunfs/root/lando", "init"],
      cwd: "/work",
      standalone: true,
    });
    const result = await runner({ command: "services:list", args: ["--type=php"] });
    expect(result).toEqual({ exitCode: 0, stdout: "php\n", stderr: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toEqual(["/usr/bin/lando", "services:list", "--type=php"]);
    expect(calls[0]?.cwd).toBe("/work");
  });
});
