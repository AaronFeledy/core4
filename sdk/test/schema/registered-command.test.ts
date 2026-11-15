import { expect, test } from "bun:test";
import { RegisteredCommand, ToolingInputDeclaration } from "@lando/sdk/schema";
import { Schema } from "effect";

const identity = { id: "app:info", summary: "Info task", hidden: true };
const input = Schema.decodeUnknownSync(ToolingInputDeclaration)({
  flags: [],
  args: [],
  acceptsArguments: true,
  revision: "fixture",
});
const arms = [
  { ...identity, _tag: "Ready", input, runs: { kind: "script", path: ".lando/scripts/info.bun.sh" } },
  { ...identity, _tag: "Disabled", source: { path: ".lando.yml", task: "info" } },
  {
    ...identity,
    _tag: "Unavailable",
    diagnostic: {
      _tag: "ToolingCompileError",
      tool: "info",
      source: { path: ".lando.yml", task: "info" },
      message: "Invalid task",
      remediation: "Fix the declaration",
      issues: [],
      omittedIssueCount: 3,
    },
  },
  {
    ...identity,
    _tag: "Unavailable",
    diagnostic: { _tag: "ScriptDiscoveryError", message: "Invalid script" },
  },
] as const;

test.each(arms)("registered command preserves the $_tag availability contract on round trip", (arm) => {
  const decode = Schema.decodeUnknownSync(RegisteredCommand);
  const decoded = decode(arm, { onExcessProperty: "error" });
  const encoded = Schema.encodeSync(RegisteredCommand)(decoded);
  expect(encoded).toEqual(arm);
  expect(decode(encoded, { onExcessProperty: "error" })).toEqual(decoded);
});

test.each([
  { ...identity, _tag: "Ready" },
  { ...identity, _tag: "Disabled" },
  { ...identity, _tag: "Unavailable" },
  { ...identity, _tag: "Disabled", input, source: { path: ".lando.yml", task: "info" } },
  { ...identity, _tag: "Unavailable", input, diagnostic: { _tag: "ScriptError", message: "Failure" } },
  { ...identity, _tag: "Ready", input, diagnostic: { _tag: "ScriptError", message: "Failure" } },
])("registered command rejects missing payloads and conflicting availability in %j", (value) => {
  expect(() => Schema.decodeUnknownSync(RegisteredCommand)(value, { onExcessProperty: "error" })).toThrow();
});
