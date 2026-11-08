import { describe, expect, test } from "bun:test";
import { Result } from "effect";

import { guideCommandArgv } from "../../src/docs/guide-compiler/command-argv.ts";

const argv = (command: string) => Result.getOrThrow(guideCommandArgv(command));
const issue = (command: string) => {
  const result = guideCommandArgv(command);
  if (Result.isSuccess(result)) throw new Error(`accepted ${command}`);
  return { reason: result.failure.reason, index: result.failure.index, character: result.failure.character };
};

describe("guideCommandArgv", () => {
  test.each([
    ["lando start", ["lando", "start"]],
    ["  lando\tinfo   --format=json ", ["lando", "info", "--format=json"]],
    ["lando init --name 'My App'", ["lando", "init", "--name", "My App"]],
    ['lando init --name "My App"', ["lando", "init", "--name", "My App"]],
    ["lando exec -- printf '' x", ["lando", "exec", "--", "printf", "", "x"]],
    ['lando exec -- printf ""', ["lando", "exec", "--", "printf", ""]],
    [`lando bun -e 'console.log("hi")'`, ["lando", "bun", "-e", 'console.log("hi")']],
    [
      `lando mongosh --eval "db.notes.findOne({_id: 'guide'})"`,
      ["lando", "mongosh", "--eval", "db.notes.findOne({_id: 'guide'})"],
    ],
    [`lando x "a \\"quoted\\" word"`, ["lando", "x", 'a "quoted" word']],
    [`lando x "keeps \\n and \\t"`, ["lando", "x", "keeps \\n and \\t"]],
    [`lando x "\\$HOME" \\$HOME`, ["lando", "x", "$HOME", "$HOME"]],
    ["lando x 'it'\\''s'", ["lando", "x", "it's"]],
    ["lando x pre'mid'\"post\"", ["lando", "x", "premidpost"]],
    ["lando x a\\ b", ["lando", "x", "a b"]],
    ["lando x \\\n  --flag", ["lando", "x", "--flag"]],
    [
      "lando x a,b mail@example.test key=value 50%",
      ["lando", "x", "a,b", "mail@example.test", "key=value", "50%"],
    ],
    ["lando x a#b a~b", ["lando", "x", "a#b", "a~b"]],
    ["lando x '[0]' '{a,b}' '*' '!'", ["lando", "x", "[0]", "{a,b}", "*", "!"]],
  ] as const)("reads %j as a shell does", (command, expected) => {
    expect(argv(command)).toEqual([...expected]);
  });

  test.each([
    ["lando init --name 'My App", { reason: "unterminated-quote", index: 18, character: "'" }],
    ['lando init --name "My App', { reason: "unterminated-quote", index: 18, character: '"' }],
    ['lando x "ends with \\', { reason: "unterminated-quote", index: 8, character: '"' }],
    ["lando x \\", { reason: "dangling-escape", index: 8, character: "\\" }],
    ["lando info | jq .", { reason: "shell-syntax", index: 11, character: "|" }],
    ["lando info > out.txt", { reason: "shell-syntax", index: 11, character: ">" }],
    ["lando start; lando info", { reason: "shell-syntax", index: 11, character: ";" }],
    ["lando start\nlando info", { reason: "shell-syntax", index: 11, character: "\n" }],
    ["lando x $HOME", { reason: "shell-syntax", index: 8, character: "$" }],
    ['lando x "$HOME"', { reason: "shell-syntax", index: 9, character: "$" }],
    ['lando x "`id`"', { reason: "shell-syntax", index: 9, character: "`" }],
    ["lando x *.php", { reason: "shell-syntax", index: 8, character: "*" }],
    ["lando list --jq=[.result]", { reason: "shell-syntax", index: 16, character: "[" }],
    ['lando config set appEnv {"A":"b"}', { reason: "shell-syntax", index: 24, character: "{" }],
    ["lando x db.ping()", { reason: "shell-syntax", index: 15, character: "(" }],
    ["lando x !", { reason: "shell-syntax", index: 8, character: "!" }],
    ["lando x ~/app", { reason: "shell-syntax", index: 8, character: "~" }],
    ["lando x #comment", { reason: "shell-syntax", index: 8, character: "#" }],
    ["LANDO_PROVIDER=test lando version", { reason: "shell-syntax", index: 14, character: "=" }],
    ["  A=1 lando version", { reason: "shell-syntax", index: 3, character: "=" }],
    ["   ", { reason: "empty-command", index: 0, character: " " }],
    ["", { reason: "empty-command", index: 0, character: "" }],
  ] as const)("rejects %j", (command, expected) => {
    expect(issue(command)).toEqual(expected);
  });

  test("carries the command and a remediation on the tagged failure", () => {
    const result = guideCommandArgv("lando info | jq .");
    if (Result.isSuccess(result)) throw new Error("accepted a pipeline");
    expect(result.failure).toMatchObject({
      _tag: "GuideCommandSyntaxError",
      command: "lando info | jq .",
      reason: "shell-syntax",
    });
    expect(result.failure.remediation).toContain("single quotes");
  });
});
