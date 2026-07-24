import { describe, expect, test } from "bun:test";

import { buildToolingInvocation, validateToolingArguments } from "../../src/cli/commands/tooling.ts";

describe("buildToolingInvocation", () => {
  test("preserves pass-through argument boundaries for string tooling commands", () => {
    // Given
    const task = { service: "appserver", cmds: ["vendor/bin/drush"] };
    const args = ["site:install", "--site-name=Lando Drupal 11", "", "$(touch /tmp/unwanted)", "it's-safe"];

    // When
    const invocation = buildToolingInvocation("drush", task, { args });

    // Then
    expect(invocation.commands).toEqual([["sh", "-c", 'vendor/bin/drush "$@"', "lando-tooling", ...args]]);
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
  });

  test("keeps array-form commands as direct argv", () => {
    // Given
    const task = { cmd: ["php", "-r", "echo $argv[1];"] };

    // When
    const invocation = buildToolingInvocation("php", task, { args: ["two words", ""] });

    // Then
    expect(invocation.commands).toEqual([["php", "-r", "echo $argv[1];", "two words", ""]]);
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
