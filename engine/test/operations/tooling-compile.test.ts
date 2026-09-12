import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { PortablePath, type ToolingTaskShape } from "@lando/sdk/schema";

import { compileToolingInvocations, validateToolingArguments } from "../../src/operations/tooling-compile.ts";

const source = { path: "/app/.lando.yml", task: "task" } as const;

const compile = (name: string, task: ToolingTaskShape, options: Record<string, unknown> = {}) =>
  Effect.runSync(
    compileToolingInvocations({ name, lookupKey: name, task, source, ...options }).pipe(
      Effect.map((compiled) => compiled.invocations),
    ),
  );

describe("compileToolingInvocations", () => {
  test("preserves pass-through argument boundaries for string tooling commands", () => {
    // Given
    const task = { service: "appserver", cmds: ["vendor/bin/drush"] };
    const args = ["site:install", "--site-name=Lando Drupal 11", "", "$(touch /tmp/unwanted)", "it's-safe"];

    // When
    const invocations = compile("drush", task, { args });

    // Then
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.commands).toEqual([
      ["sh", "-c", 'vendor/bin/drush "$@"', "lando-tooling", ...args],
    ]);
    expect(invocations[0]?.hostSteps).toEqual([{ kind: "shell", source: "vendor/bin/drush", argv: args }]);
  });

  test("compiles one invocation per authored step so each step keeps its own target", () => {
    // Given
    const task = { cmds: ["composer validate", { cmd: "vendor/bin/drush", service: "worker" }] };

    // When
    const invocations = compile("check", task, { args: ["status", "--field=bootstrap"] });

    // Then each step is separately addressable rather than collapsed into one invocation
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.commands).toEqual([["sh", "-c", 'composer validate "$@"', "lando-tooling"]]);
    expect(invocations[1]?.commands).toEqual([
      ["sh", "-c", 'vendor/bin/drush "$@"', "lando-tooling", "status", "--field=bootstrap"],
    ]);
    expect(invocations[1]?.service).toBe("worker");
  });

  test("passes arguments only to the final step in a command sequence", () => {
    // Given
    const task = { cmds: ["composer validate", "vendor/bin/drush"] };

    // When
    const invocations = compile("check", task, { args: ["status"] });

    // Then
    expect(invocations.map((invocation) => invocation.hostSteps)).toEqual([
      [{ kind: "shell", source: "composer validate", argv: [] }],
      [{ kind: "shell", source: "vendor/bin/drush", argv: ["status"] }],
    ]);
  });

  test("keeps array-form commands as direct argv", () => {
    // Given
    const task = { cmd: ["php", "-r", "echo $argv[1];"] };

    // When
    const invocations = compile("php", task, { args: ["two words", ""] });

    // Then
    expect(invocations[0]?.commands).toEqual([["php", "-r", "echo $argv[1];", "two words", ""]]);
    expect(invocations[0]?.hostSteps).toEqual([
      { kind: "argv", argv: ["php", "-r", "echo $argv[1];", "two words", ""] },
    ]);
  });

  test("uses the folded task dir as the invocation cwd", () => {
    // Given
    const task = { cmd: "pwd", dir: PortablePath.make("/workspace/from-task") };

    // When
    const invocations = compile("pwd", task);

    // Then
    expect(invocations[0]?.cwd).toBe("/workspace/from-task");
  });

  test("falls back to the caller cwd when the folded task has no dir", () => {
    // Given
    const task = { cmd: "pwd" };

    // When
    const invocations = compile("pwd", task, { cwd: "/workspace/from-caller" });

    // Then
    expect(invocations[0]?.cwd).toBe("/workspace/from-caller");
  });

  test("prefers the folded task dir over a differing caller cwd", () => {
    // Given
    const task = { cmd: "pwd", dir: PortablePath.make("/workspace/from-task") };

    // When
    const invocations = compile("pwd", task, { cwd: "/workspace/from-caller" });

    // Then
    expect(invocations[0]?.cwd).toBe("/workspace/from-task");
  });

  test("merges folded task env beneath explicit caller env", () => {
    // Given
    const task = { cmd: "env", env: { FROM_TASK: "task", SHARED: "task" } };

    // When
    const invocations = compile("env", task, { env: { FROM_CALLER: "caller", SHARED: "caller" } });

    // Then
    expect(invocations[0]?.env).toEqual({
      FROM_TASK: "task",
      FROM_CALLER: "caller",
      SHARED: "caller",
    });
  });

  test("omits env when neither the folded task nor the caller supplies it", () => {
    // Given
    const task = { cmd: "env" };

    // When
    const invocations = compile("env", task);

    // Then
    expect(invocations[0]).not.toHaveProperty("env");
  });

  test("does not append argv when a string command already references positional parameters", () => {
    // Given
    const task = { cmd: 'printf "<%s>\\n" "$@"' };

    // When
    const invocations = compile("printf", task, { args: ["one", "two"] });

    // Then
    expect(invocations[0]?.commands).toEqual([
      ["sh", "-c", 'printf "<%s>\\n" "$@"', "lando-tooling", "one", "two"],
    ]);
  });

  test.each(["echo $1", "echo $9", "echo ${1:-fallback}"])(
    "does not append argv for authored positional form %s",
    (cmd) => {
      const invocations = compile("positional", { cmd }, { args: ["value"] });

      expect(invocations[0]?.commands[0]?.[2]).toBe(cmd);
    },
  );

  test("threads a precomputed agent env allowlist onto every step", () => {
    // Given
    const task = { cmds: ["one", "two"] };

    // When
    const invocations = compile("agent", task, { agentEnvAllowlist: ["LANDO_AGENT"] });

    // Then
    expect(invocations.map((invocation) => invocation.agentEnvAllowlist)).toEqual([
      ["LANDO_AGENT"],
      ["LANDO_AGENT"],
    ]);
  });

  test("fails rather than throws when a task is disabled", () => {
    // Given
    const task = { cmd: "echo ok", disabled: true };

    // When
    const result = Effect.runSync(
      compileToolingInvocations({ name: "off", lookupKey: "off", task, source }).pipe(Effect.either),
    );

    // Then
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ToolingDisabledError", tool: "off" } });
  });

  test("fails rather than throws when a task defines no steps", () => {
    // When
    const result = Effect.runSync(
      compileToolingInvocations({ name: "empty", lookupKey: "empty", task: {}, source }).pipe(Effect.either),
    );

    // Then
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ToolingCompileError" } });
  });

  test("rejects the drupal-scaffold composer.json deletion reproducer", () => {
    // Given
    const task = { acceptsArguments: false };

    // When
    const failure = validateToolingArguments("drupal-scaffold", task, ["composer.json"]);

    // Then
    expect(failure?._tag).toBe("ToolingCompileError");
    expect(failure?.tool).toBe("drupal-scaffold");
    expect(failure?.message).toContain("does not accept positional arguments");
  });
});
