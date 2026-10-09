import { describe, expect, test } from "bun:test";

import { splitComposeCommand } from "@lando/sdk/landofile";

describe("Compose/go-shellwords argv", () => {
  test.each([
    { input: "--data-dir /data --enable-cors", argv: ["--data-dir", "/data", "--enable-cors"] },
    {
      input: `worker "two words" 'three words' escaped\\ space ""`,
      argv: ["worker", "two words", "three words", "escaped space", ""],
    },
    { input: `echo "a\\b" 'c\\d'`, argv: ["echo", "ab", "c\\d"] },
    { input: "", argv: [] },
    { input: " \t\r\n", argv: [] },
    { input: `sh -c 'echo a | cat && echo b'`, argv: ["sh", "-c", "echo a | cat && echo b"] },
    {
      input: "echo $HOME ${TOKEN} $(printf secret) `printf secret`",
      argv: ["echo", "$HOME", "${TOKEN}", "$(printf secret)", "`printf secret`"],
    },
  ])("returns literal argv when input is $input", ({ input, argv }) => {
    // Given / When
    const result = splitComposeCommand(input);
    // Then
    expect(result).toEqual({ argv, truncated: false });
  });

  test.each([";", "&", "|", "<", ">"])("truncates at an unquoted %s operator", (operator) => {
    // Given
    const input = `echo first ${operator} ignored "unterminated`;
    // When
    const result = splitComposeCommand(input);
    // Then
    expect(result).toEqual({ argv: ["echo", "first"], truncated: true });
  });

  test("drops a file descriptor when redirection truncates input", () => {
    // Given / When
    const result = splitComposeCommand("echo first 2>ignored");
    // Then
    expect(result).toEqual({ argv: ["echo", "first"], truncated: true });
  });

  test.each([
    `worker "unterminated`,
    "worker 'unterminated",
    "worker trailing\\",
    "echo $(unterminated",
    "echo `unterminated",
    "echo (unsupported)",
  ])("rejects malformed input when given %s", (input) => {
    // Given / When
    const result = splitComposeCommand(input);
    // Then
    expect(result).toBeUndefined();
  });
});
