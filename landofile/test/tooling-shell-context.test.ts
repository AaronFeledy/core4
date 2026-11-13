import { expect, test } from "bun:test";
import { shellContext } from "../src/tooling-shell-context.ts";
import { isSafeShellInsertion, shellInsertionRefusal } from "../src/tooling-shell-insertion.ts";

test.each([
  ["", "unquoted"],
  ["printf '%s' ", "unquoted"],
  ["printf '%s' '", "single"],
  ['printf "%s" "', "double"],
  ["printf '%s' ", "unquoted"],
] as const)("reports the insertion position at %j as %s", (text, insertion) => {
  // When
  const context = shellContext(text);
  // Then
  expect(context.insertion).toBe(insertion);
  expect(shellInsertionRefusal(context.insertion)).toBeUndefined();
  expect(isSafeShellInsertion(context.insertion)).toBe(true);
});

test.each([
  ["echo hi # ", "comment"],
  ["cat <<EOF\n", "heredoc"],
  ["echo `", "backtick"],
  ["echo ${X:-", "parameter"],
  ["echo $((", "arithmetic"],
  ["echo $'", "dollar-quote"],
  ["echo $(case x in x) ", "case"],
  ["echo \\", "escaped"],
] as const)("names the refusing insertion position at %j as %s", (text, insertion) => {
  // When
  const context = shellContext(text);
  // Then
  expect(context.insertion).toBe(insertion);
  expect(shellInsertionRefusal(context.insertion)).toBeString();
  expect(isSafeShellInsertion(context.insertion)).toBe(false);
});

test("keeps the scanner results existing callers depend on", () => {
  // Given
  const command = shellContext("printf '%s' ");
  const argument = shellContext("printf '%s' value");
  const redirect = shellContext("printf %s value > ");
  const nearDollar = shellContext("printf %s $");
  // Then
  expect(command).toMatchObject({ refused: false, quote: undefined, command: true, redirect: false });
  expect(command.word).toBe("");
  expect(argument).toMatchObject({ refused: false, quote: undefined, command: true });
  expect(argument.word).toBe("value");
  expect(redirect.redirect).toBe(true);
  expect(nearDollar.dollar).toBe(true);
});

test("refuses an unterminated here-document body", () => {
  // When
  const context = shellContext("cat <<EOF\nbody");
  // Then
  expect(context.refused).toBe(true);
  expect(context.insertion).toBe("heredoc");
});

test("an escaped dollar is not a dollar refusal", () => {
  // When / Then
  expect(shellContext("echo \\$")).toMatchObject({ dollar: false, escaped: false });
});
