import { expect, test } from "bun:test";
import {
  MCP_ALLOWLIST_FORBIDDEN_IDS,
  MCP_NEVER_ALLOWED_IDS,
  computeMcpDefaultAllowlist,
  filterMcpDefaultAllowlist,
  isMcpAllowlistForbidden,
  isMcpDestructiveCommand,
  isMcpNeverAllowed,
} from "@lando/mcp/allowlist";
import { buildCatalog, computeEffectiveAllowlist } from "@lando/mcp/catalog";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { Effect, Schema } from "effect";

test.each([
  { id: "app:destroy" },
  { id: "meta:global:disable" },
  { id: "meta:global:reconcile" },
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
  const entries = [
    { kind: "command" as const, spec, plugin: { name: "fixture", source: "bundled" as const } },
  ] satisfies readonly McpCommandEntry[];
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

test("db:creds:apply is forbidden, never-allowed, and stays out of MCP even with explicit allow", () => {
  const id = "db:creds:apply";
  const spec = {
    id,
    summary: "Apply Landofile credentials to a running database service.",
    // Deliberate self-allow attempt must still be excluded from defaults and catalog.
    mcpAllowed: true,
    flags: { yes: { type: "boolean", default: false } },
    resultSchema: Schema.Unknown,
    run: () => Effect.succeed({}),
  };
  const entries = [
    { kind: "command" as const, spec, plugin: { name: "@lando/sql", source: "bundled" as const } },
  ] satisfies readonly McpCommandEntry[];

  expect(isMcpAllowlistForbidden(id)).toBe(true);
  expect(MCP_ALLOWLIST_FORBIDDEN_IDS).toContain(id);
  expect(isMcpNeverAllowed(id)).toBe(true);
  expect(MCP_NEVER_ALLOWED_IDS.has(id)).toBe(true);
  expect(isMcpDestructiveCommand(spec)).toBe(true);

  // Defaults refuse self-allow + never-allowed; explicit catalog allow still projects nothing.
  expect(computeMcpDefaultAllowlist([spec])).toEqual([]);
  expect(filterMcpDefaultAllowlist([id], entries)).toEqual([]);
  const catalog = buildCatalog({
    commandEntries: entries,
    effective: computeEffectiveAllowlist({ defaults: [], allow: [id] }),
  });
  expect(catalog.tools.map((tool) => tool.commandId)).not.toContain(id);
  expect(catalog.tools).toEqual([]);
});
