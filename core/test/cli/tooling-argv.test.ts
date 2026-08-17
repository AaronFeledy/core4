import { describe, expect, test } from "bun:test";

import { buildToolingInvocation, validateToolingArguments } from "@lando/engine/operations/tooling";
import { PortablePath } from "@lando/sdk/schema";

describe("buildToolingInvocation", () => {
  test("preserves pass-through argument boundaries for string tooling commands", () => {
    // Given
    const task = { service: "appserver", cmds: ["vendor/bin/drush"] };
    const args = ["site:install", "--site-name=Lando Drupal 11", "", "$(touch /tmp/unwanted)", "it's-safe"];

    // When
    const invocation = buildToolingInvocation("drush", task, { args });

    // Then
    expect(invocation.commands).toEqual([["sh", "-c", 'vendor/bin/drush "$@"', "lando-tooling", ...args]]);
    expect(invocation.hostSteps).toEqual([{ kind: "shell", source: "vendor/bin/drush", argv: args }]);
  });

  test("passes arguments only to the final command in a string command sequence", () => {
    // Given
    const task = { cmds: ["composer validate", "vendor/bin/drush"] };

    // When
    const invocation = buildToolingInvocation("check", task, { args: ["status", "--field=bootstrap"] });

    // Then
    expect(invocation.commands).toEqual([
      ["sh", "-c", 'composer validate "$@"', "lando-tooling"],
      ["sh", "-c", 'vendor/bin/drush "$@"', "lando-tooling", "status", "--field=bootstrap"],
    ]);
    expect(invocation.hostSteps).toEqual([
      { kind: "shell", source: "composer validate", argv: [] },
      { kind: "shell", source: "vendor/bin/drush", argv: ["status", "--field=bootstrap"] },
    ]);
  });

  test("keeps array-form commands as direct argv", () => {
    // Given
    const task = { cmd: ["php", "-r", "echo $argv[1];"] };

    // When
    const invocation = buildToolingInvocation("php", task, { args: ["two words", ""] });

    // Then
    expect(invocation.commands).toEqual([["php", "-r", "echo $argv[1];", "two words", ""]]);
    expect(invocation.hostSteps).toEqual([
      { kind: "argv", argv: ["php", "-r", "echo $argv[1];", "two words", ""] },
    ]);
  });

  test("uses the folded task dir as the invocation cwd", () => {
    // Given
    const task = { cmd: "pwd", dir: PortablePath.make("/workspace/from-task") };

    // When
    const invocation = buildToolingInvocation("pwd", task);

    // Then
    expect(invocation.cwd).toBe("/workspace/from-task");
  });

  test("falls back to the caller cwd when the folded task has no dir", () => {
    // Given
    const task = { cmd: "pwd" };

    // When
    const invocation = buildToolingInvocation("pwd", task, { cwd: "/workspace/from-caller" });

    // Then
    expect(invocation.cwd).toBe("/workspace/from-caller");
  });

  test("prefers the folded task dir over a differing caller cwd", () => {
    // Given
    const task = { cmd: "pwd", dir: PortablePath.make("/workspace/from-task") };

    // When
    const invocation = buildToolingInvocation("pwd", task, { cwd: "/workspace/from-caller" });

    // Then
    expect(invocation.cwd).toBe("/workspace/from-task");
  });

  test("merges folded task env beneath explicit caller env", () => {
    // Given
    const task = { cmd: "env", env: { FROM_TASK: "task", SHARED: "task" } };

    // When
    const invocation = buildToolingInvocation("env", task, {
      env: { FROM_CALLER: "caller", SHARED: "caller" },
    });

    // Then
    expect(invocation.env).toEqual({ FROM_TASK: "task", FROM_CALLER: "caller", SHARED: "caller" });
  });

  test("omits env when neither the folded task nor the caller supplies it", () => {
    // Given
    const task = { cmd: "env" };

    // When
    const invocation = buildToolingInvocation("env", task);

    // Then
    expect(invocation).not.toHaveProperty("env");
  });

  test("does not append argv when a string command already references positional parameters", () => {
    // Given
    const task = { cmd: 'printf "<%s>\\n" "$@"' };

    // When
    const invocation = buildToolingInvocation("printf", task, { args: ["one", "two"] });

    // Then
    expect(invocation.commands).toEqual([
      ["sh", "-c", 'printf "<%s>\\n" "$@"', "lando-tooling", "one", "two"],
    ]);
  });

  test.each(["echo $1", "echo $9", "echo ${1:-fallback}"])(
    "does not append argv for authored positional form %s",
    (cmd) => {
      const invocation = buildToolingInvocation("positional", { cmd }, { args: ["value"] });

      expect(invocation.commands[0]?.[2]).toBe(cmd);
    },
  );

  test("rejects the drupal-scaffold composer.json deletion reproducer", () => {
    // Given
    const task = { cmd: "rm -f state", arguments: false as const };

    // When
    const failure = validateToolingArguments("drupal-scaffold", task, ["composer.json"]);

    // Then
    expect(failure?._tag).toBe("ToolingCompileError");
    expect(failure?.tool).toBe("drupal-scaffold");
    expect(failure?.message).toContain("does not accept positional arguments");
  });
});
