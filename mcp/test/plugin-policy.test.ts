import { expect, test } from "bun:test";
import {
  computeMcpDefaultAllowlist,
  filterMcpDefaultAllowlist,
  isMcpDestructiveCommand,
} from "@lando/mcp/allowlist";
import { buildCatalog, computeEffectiveAllowlist } from "@lando/mcp/catalog";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { Effect, Schema } from "effect";

test.each([
  { id: "app:destroy" },
  { id: "fixture:restore" },
  { id: "fixture:inspect", flags: { yes: { type: "boolean" } } },
])("one classifier excludes destructive defaults and marks explicitly allowed $id", (surface) => {
  const spec = {
    ...surface,
    summary: "Fixture",
    mcpAllowed: true,
    resultSchema: Schema.Unknown,
    run: () => Effect.succeed({}),
  };
  const entries: readonly McpCommandEntry[] = [{ spec, plugin: { name: "fixture", source: "bundled" } }];
  expect(isMcpDestructiveCommand(spec)).toBe(true);
  expect(() => computeMcpDefaultAllowlist([spec])).toThrow();
  expect(filterMcpDefaultAllowlist([spec.id], entries)).toEqual([]);
  const catalog = buildCatalog({
    commandEntries: entries,
    effective: computeEffectiveAllowlist({ defaults: [], allow: [spec.id] }),
  });
  expect(catalog.tools[0]?.destructive).toBe(true);
});

test("external replacement of a bundled id never inherits a default", () => {
  const spec = {
    id: "db:snapshots",
    summary: "Replacement",
    mcpAllowed: true,
    resultSchema: Schema.Unknown,
    run: () => Effect.succeed({}),
  };
  expect(
    filterMcpDefaultAllowlist([spec.id], [{ spec, plugin: { name: "replacement", source: "external" } }]),
  ).toEqual([]);
});
