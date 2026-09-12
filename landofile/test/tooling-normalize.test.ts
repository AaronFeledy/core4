import { describe, expect, test } from "bun:test";
import { PortablePath, type ToolingTaskShape } from "@lando/sdk/schema";
import { Either } from "effect";
import { normalizeToolingTask, requiresProvider } from "../src/tooling-normalize.ts";

describe("normalizeToolingTask", () => {
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
    const result = Either.getOrThrow(normalizeToolingTask("run", task));
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

  test("preserves argv boundaries and command-field authored order", () => {
    // Given
    const task: ToolingTaskShape = { cmds: ["first"], cmd: ["echo", "two words"] };
    // When
    const result = Either.getOrThrow(normalizeToolingTask("run", task));
    // Then
    expect(result.steps).toEqual([
      { cmd: "first", env: {} },
      { cmd: "echo two words", argv: ["echo", "two words"], env: {} },
    ]);
  });

  test.each([
    [":web", { kind: "flag", flag: "web" }],
    [":host", { kind: "host" }],
    ["appserver", { kind: "service", name: "appserver" }],
  ] as const)("parses service %s", (service, expected) => {
    // Given / When
    const result = Either.getOrThrow(normalizeToolingTask("run", { service, flags: { web: {} } }));
    // Then
    expect(result.service).toEqual(expected);
  });

  const invalid: readonly (readonly [string, ToolingTaskShape])[] = [
    ["boolean service flag", { service: ":loud", flags: { loud: { boolean: true } } }],
    ["undeclared service flag", { service: ":nope" }],
    ["invalid step service", { cmds: [{ cmd: "a", service: ":nope" }] }],
    ["duplicate order", { args: { a: { order: 0 }, b: { order: 0 } } }],
    ["partial order", { args: { a: { order: 0 }, b: {} } }],
    ["duplicate aliases", { flags: { a: { alias: "x" }, b: { alias: "x" } } }],
    ["alias collides with name", { flags: { a: { alias: "b" }, b: {} } }],
    ["required flag default", { flags: { a: { required: true, default: "x" } } }],
    ["required arg default", { args: { a: { required: true, default: "x" } } }],
    ["boolean choices", { flags: { a: { boolean: true, choices: ["true"] } } }],
    ["flag default outside choices", { flags: { a: { default: "x", choices: ["y"] } } }],
    ["arg default outside choices", { args: { a: { default: 1, choices: ["2"] } } }],
    ["required arg after optional", { args: { a: {}, b: { required: true } } }],
    ["empty object command", { cmds: [{ cmd: " " }] }],
  ];
  test.each(invalid)("rejects %s", (_label, task) => {
    // Given / When
    const result = normalizeToolingTask("run", task, { path: "/app/.lando.yml" });
    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "ToolingCompileError",
        tool: "run",
        source: { path: "/app/.lando.yml", task: "run" },
      });
      expect(result.left.remediation).toBeTruthy();
    }
  });

  test("normalizes metadata, scalar defaults and explicit arg order", () => {
    // Given
    const task: ToolingTaskShape = {
      description: "preferred",
      summary: "fallback",
      arguments: false,
      disabled: true,
      flags: { count: { default: 2 } },
      args: { b: { order: 2, default: false }, a: { order: 1, required: true } },
    };
    // When
    const result = Either.getOrThrow(normalizeToolingTask("run", task));
    // Then
    expect(result).toMatchObject({
      summary: "preferred",
      disabled: true,
      hasInput: true,
      acceptsArguments: false,
      flags: [{ name: "count", default: "2", boolean: false, required: false }],
      args: [
        { name: "a", order: 1 },
        { name: "b", order: 2, default: "false" },
      ],
    });
  });

  test("defaults input and disabled metadata", () => {
    // Given / When
    const result = Either.getOrThrow(normalizeToolingTask("run", {}));
    // Then
    expect(result).toMatchObject({ disabled: false, hasInput: false, acceptsArguments: true });
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
      const normalized = Either.getOrThrow(normalizeToolingTask("run", task));
      // When
      const result = requiresProvider(normalized);
      // Then
      expect(result).toBe(expected);
    },
  );
});
