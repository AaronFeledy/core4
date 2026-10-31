import { expect, test } from "bun:test";
import { CommandContribution, PluginManifest } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test.each([
  "db:x",
  { id: "db:x", summary: "  " },
  { id: "db:x", summary: "Inspect database.", aliases: ["Bad Alias"] },
  { id: "db:x", summary: "x".repeat(513) },
  { id: "bad", summary: "Invalid canonical id." },
])("rejects invalid manifest command %j", (command) => {
  const input = { name: "@example/commands", version: "1.0.0", api: 4, contributes: { commands: [command] } };
  const decoded = Schema.decodeUnknownResult(PluginManifest)(input);
  expect(Result.isFailure(decoded)).toBe(true);
});

test("decodes declarative command metadata without an implementation", () => {
  const descriptor = {
    id: "db:x",
    summary: "Inspect database.",
    aliases: ["db:i"],
    topLevelAlias: "inspect",
    mcpAllowed: true,
  };
  expect(Schema.decodeUnknownSync(CommandContribution)(descriptor)).toEqual(descriptor);
});

test.each([
  "plugin:owned",
  "meta:plugin:owned",
  "meta:global:owned",
  "scratch:owned",
  "apps:scratch:owned",
  "global:owned",
])("rejects reserved canonical namespace %s", (id) => {
  // Given a plugin claiming a host-owned namespace.
  const descriptor = { id, summary: "Inspect a resource." };
  // When decoding the command descriptor.
  const decoded = Schema.decodeUnknownResult(CommandContribution)(descriptor);
  // Then the command cannot enter a plugin index.
  expect(Result.isFailure(decoded)).toBe(true);
});
