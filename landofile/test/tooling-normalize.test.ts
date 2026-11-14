import { describe, expect, test } from "bun:test";
import { PortablePath, type ToolingTaskShape, formatValidationIssuePath } from "@lando/sdk/schema";
import { Result } from "effect";
import { inspectToolingTask, normalizeToolingTask, requiresProvider } from "../src/tooling-normalize.ts";

describe("normalizeToolingTask", () => {
  test.each([
    [{ cmd: "sh reset.sh" }, false],
    [{ cmd: "wp", wrapper: true }, true],
    [{ cmd: ["echo", "$1", "&&"], wrapper: true }, true],
    [{ cmds: ["echo hi"], wrapper: true }, true],
    [{ cmd: "cd x && y" }, false],
    [{ cmd: "echo $1" }, false],
    [{ cmd: 'echo "$@"' }, false],
    [{ cmd: "echo ${1}" }, false],
    [{ cmd: "echo hi\necho bye" }, false],
    [{ cmds: ["echo a", "echo b"] }, false],
    [{ cmd: "echo a; echo b" }, false],
    [{ cmd: "echo a | cat" }, false],
    [{ cmd: "echo a > marker" }, false],
    [{ cmd: "cat < input" }, false],
    [{ cmd: "(echo a)" }, false],
    [{ cmd: "echo `pwd`" }, false],
    [{ cmd: "echo a &" }, false],
    [{ cmd: "echo hi", flags: { loud: { boolean: true } } }, false],
    [{ cmd: "echo hi", arguments: false }, false],
    [{ cmd: "echo hi", wrapper: false }, false],
    [{ cmds: ["a", "b"], flags: { loud: { boolean: true } }, args: { target: {} }, wrapper: false }, false],
    [{ cmd: "a", arguments: false, wrapper: false }, false],
    [{}, false],
  ] satisfies readonly (readonly [ToolingTaskShape, boolean])[])(
    "Given %j, when normalized, then wrapper is %s",
    (task, expected) => {
      // Given / When
      const normalized = Result.getOrThrow(normalizeToolingTask("run", task));
      // Then
      expect(normalized.wrapper).toBe(expected);
    },
  );

  test("preserves mixed steps and independently inherits execution settings", () => {
    // Given
    const task: ToolingTaskShape = {
      service: ":host",
      user: "task-user",
      dir: PortablePath.make("/task"),
      env: { KEEP: "yes", CHANGE: "task" },
      cmds: [
        "a",
        { cmd: "b", service: "web", dir: PortablePath.make("/step"), env: { CHANGE: "step" } },
        { cmd: "c", user: "step-user" },
      ],
    };
    // When
    const result = Result.getOrThrow(normalizeToolingTask("run", task));
    // Then
    expect(result.steps).toEqual([
      {
        cmd: "a",
        service: { kind: "host" },
        user: "task-user",
        dir: "/task",
        env: { KEEP: "yes", CHANGE: "task" },
      },
      {
        cmd: "b",
        service: { kind: "service", name: "web" },
        user: "task-user",
        dir: "/step",
        env: { KEEP: "yes", CHANGE: "step" },
      },
      {
        cmd: "c",
        service: { kind: "host" },
        user: "step-user",
        dir: "/task",
        env: { KEEP: "yes", CHANGE: "task" },
      },
    ]);
  });

  test("preserves argv boundaries for array cmd", () => {
    // Given
    const task: ToolingTaskShape = { cmd: ["echo", "two words"] };
    // When
    const result = Result.getOrThrow(normalizeToolingTask("run", task));
    // Then
    expect(result.steps).toEqual([{ cmd: "echo two words", argv: ["echo", "two words"], env: {} }]);
  });

  test.each([
    [":web", { kind: "flag", flag: "web" }],
    [":host", { kind: "host" }],
    ["appserver", { kind: "service", name: "appserver" }],
  ] as const)("parses service %s", (service, expected) => {
    // Given / When
    const result = Result.getOrThrow(normalizeToolingTask("run", { service, flags: { web: {} } }));
    // Then
    expect(result.service).toEqual(expected);
  });

  const invalid: readonly (readonly [string, ToolingTaskShape, readonly (string | number)[]])[] = [
    ["boolean service flag", { service: ":loud", flags: { loud: { boolean: true } } }, ["service"]],
    ["undeclared service flag", { service: ":nope" }, ["service"]],
    ["undeclared prototype service flag", { service: ":toString", flags: {} }, ["service"]],
    ["invalid step service", { cmds: [{ cmd: "a", service: ":nope" }] }, ["cmds", 0, "service"]],
    ["duplicate order", { args: { a: { order: 0 }, b: { order: 0 } } }, ["args", "b", "order"]],
    ["partial order", { args: { a: { order: 0 }, b: {} } }, ["args", "b", "order"]],
    ["duplicate aliases", { flags: { a: { alias: "x" }, b: { alias: "x" } } }, ["flags", "b", "alias"]],
    ["alias collides with name", { flags: { a: { alias: "b" }, b: {} } }, ["flags", "a", "alias"]],
    ["required flag default", { flags: { a: { required: true, default: "x" } } }, ["flags", "a", "default"]],
    ["required arg default", { args: { a: { required: true, default: "x" } } }, ["args", "a", "default"]],
    ["boolean choices", { flags: { a: { boolean: true, choices: ["true"] } } }, ["flags", "a", "choices"]],
    [
      "flag default outside choices",
      { flags: { a: { default: "x", choices: ["y"] } } },
      ["flags", "a", "default"],
    ],
    [
      "arg default outside choices",
      { args: { a: { default: 1, choices: ["2"] } } },
      ["args", "a", "default"],
    ],
    ["required arg after optional", { args: { a: {}, b: { required: true } } }, ["args", "b", "order"]],
    ["empty object command", { cmds: [{ cmd: " " }] }, ["cmds", 0, "cmd"]],
    ["cmd and cmds together", { cmd: "a", cmds: ["b"] }, ["cmds"]],
    ["wrapper with invalid step", { wrapper: true, cmds: [{ cmd: " " }] }, ["cmds", 0, "cmd"]],
    ["wrapper with conflicting commands", { wrapper: true, cmd: "a", cmds: ["b"] }, ["cmds"]],
    ["wrapper with two commands", { cmds: ["a", "b"], wrapper: true }, ["wrapper"]],
    ["wrapper without a command", { wrapper: true }, ["wrapper"]],
    ["wrapper with flags", { cmd: "a", wrapper: true, flags: { loud: { boolean: true } } }, ["wrapper"]],
    ["wrapper with args", { cmd: "a", wrapper: true, args: { target: {} } }, ["wrapper"]],
    ["wrapper with arguments disabled", { cmd: "a", wrapper: true, arguments: false }, ["wrapper"]],
    ["reserved task env", { env: { LANDO_X: "hidden" } }, ["env", "LANDO_X"]],
    [
      "reserved step env",
      { cmds: [{ cmd: "echo x", env: { LANDO_X: "hidden" } }] },
      ["cmds", 0, "env", "LANDO_X"],
    ],
    [
      "reserved var env",
      { vars: { X: { sh: "echo x", env: { LANDO_X: "hidden" } } } },
      ["vars", "X", "env", "LANDO_X"],
    ],
    ["invalid var service", { vars: { X: { sh: "echo x", service: ":missing" } } }, ["vars", "X", "service"]],
  ];
  test.each(invalid)("rejects %s", (_label, task, path) => {
    // Given / When
    const result = normalizeToolingTask("run", task, { path: "/app/.lando.yml" });
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "ToolingCompileError",
        tool: "run",
        source: { path: "/app/.lando.yml", task: "run" },
        message: expect.stringContaining(`tooling.run.${formatValidationIssuePath(path)}:`),
        issues: [
          { path: ["tooling", "run", ...path], reason: expect.any(String), suggestion: expect.any(String) },
        ],
        omittedIssueCount: 0,
      });
      expect(result.failure.remediation).toBeTruthy();
    }
    const inspection = inspectToolingTask("run", task);
    expect(Result.isFailure(inspection) ? inspection.failure.map((issue) => issue.path) : []).toEqual([path]);
  });

  test("locates both alias declarations without serializing the locator or authored values", () => {
    const result = normalizeToolingTask(
      "run",
      {
        flags: { first: { alias: "x", default: "hidden" }, second: { alias: "x" }, third: { alias: "x" } },
      },
      {
        path: "/app/.lando.yml",
        locate: (path) => ({ layer: "local", file: "/app/.lando.local.yml", path }),
      },
    );
    expect(Result.isFailure(result) ? result.failure.issues : []).toEqual(
      ["second", "third"].map((name) => ({
        path: ["tooling", "run", "flags", name, "alias"],
        reason: "alias-collision",
        message: "Flag alias collides with another flag name or alias.",
        suggestion: "Choose an alias that is not used by another flag name or alias.",
        source: {
          layer: "local",
          file: "/app/.lando.local.yml",
          path: ["tooling", "run", "flags", name, "alias"],
        },
        related: [
          {
            path: ["tooling", "run", "flags", "first", "alias"],
            source: {
              layer: "local",
              file: "/app/.lando.local.yml",
              path: ["tooling", "run", "flags", "first", "alias"],
            },
          },
        ],
      })),
    );
    expect(JSON.stringify(result)).not.toMatch(/hidden|locate/);
  });

  test("aggregates independent declarations while suppressing dependent order and step failures", () => {
    const result = inspectToolingTask("run", {
      service: ":missing",
      flags: { a: { required: true, default: "hidden" }, b: { boolean: true, default: "hidden" } },
      args: { a: { order: 0 }, b: { required: true }, c: { order: 0 } },
      cmds: ["echo one", "echo two"],
      env: { LANDO_X: "hidden" },
      vars: { X: { sh: "echo hidden", service: ":missing" } },
    });
    expect(Result.isFailure(result) ? result.failure.map((issue) => issue.path) : []).toEqual([
      ["flags", "a", "default"],
      ["flags", "b", "default"],
      ["args", "b", "order"],
      ["args", "c", "order"],
      ["env", "LANDO_X"],
      ["service"],
      ["vars", "X", "service"],
    ]);
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  test("normalizes metadata, scalar defaults and explicit arg order", () => {
    // Given
    const task: ToolingTaskShape = {
      description: "preferred",
      summary: "fallback",
      disabled: true,
      flags: { count: { default: 2 } },
      args: { b: { order: 2, default: false }, a: { order: 1, required: true } },
    };
    // When
    const result = Result.getOrThrow(normalizeToolingTask("run", task));
    // Then
    expect(result).toMatchObject({
      summary: "preferred",
      disabled: true,
      input: {
        acceptsArguments: true,
        flags: [{ name: "count", default: "2", boolean: false, required: false }],
        args: [
          { name: "a", order: 1 },
          { name: "b", order: 2, default: "false" },
        ],
      },
    });
  });

  test("defaults input and disabled metadata", () => {
    // Given / When
    const result = Result.getOrThrow(normalizeToolingTask("run", {}));
    // Then
    expect(result).toMatchObject({ disabled: false, input: { flags: [], args: [], acceptsArguments: true } });
  });

  test.each([
    [{ cmds: ["a", "b"], service: ":host" }, false],
    [{ cmd: "a", service: "web" }, true],
    [{ cmd: "a" }, true],
    [{ cmd: "a", service: ":web", flags: { web: {} } }, true],
    [{ service: ":host", cmds: ["a", { cmd: "b", service: "web" }] }, true],
  ] satisfies readonly (readonly [ToolingTaskShape, boolean])[])(
    "determines provider requirement for %j",
    (task, expected) => {
      // Given
      const normalized = Result.getOrThrow(normalizeToolingTask("run", task));
      // When
      const result = requiresProvider(normalized);
      // Then
      expect(result).toBe(expected);
    },
  );
});
