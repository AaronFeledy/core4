import { describe, expect, test } from "bun:test";
import { Arbitrary, FastCheck, Schema } from "effect";

import {
  McpListResultSchema,
  buildMcpListResult,
  renderMcpListResult,
} from "../../../../src/cli/commands/meta/mcp-list.ts";

describe("buildMcpListResult", () => {
  test("lists default-allowed commands sorted by id", () => {
    // Given: two default-allowed command entries in non-sorted order.
    const input = {
      defaultAllowlist: ["app:info", "meta:version"],
      commandEntries: [
        { spec: { id: "meta:version", summary: "Show version" } },
        { spec: { id: "app:info", summary: "Show app info" } },
      ],
    };

    // When: building the MCP list result.
    const result = buildMcpListResult(input);

    // Then: default tools are sorted and carry default provenance.
    expect(result.tools).toEqual([
      { id: "app:info", summary: "Show app info", source: "default" },
      { id: "meta:version", summary: "Show version", source: "default" },
    ]);
  });

  test("reports allow, deny, combined default+allow, and tooling provenance", () => {
    // Given: defaults, explicit allow/deny lists, and optional tooling entries.
    const commandEntries = [
      { spec: { id: "app:info", summary: "Show app info" } },
      { spec: { id: "app:logs", summary: "Show logs" } },
    ];
    const toolingEntries = [{ spec: { id: "tool:x", summary: "x" }, tooling: true }];

    // When: an extra command is allowed.
    const allowed = buildMcpListResult({
      defaultAllowlist: ["app:info"],
      commandEntries,
      allow: ["app:logs"],
    });

    // Then: each tool has the source that admitted it.
    expect(allowed.tools).toEqual([
      { id: "app:info", summary: "Show app info", source: "default" },
      { id: "app:logs", summary: "Show logs", source: "allow" },
    ]);

    // When: a default id is denied.
    const denied = buildMcpListResult({
      defaultAllowlist: ["app:info"],
      commandEntries,
      deny: ["app:info"],
    });

    // Then: deny wins and removes it.
    expect(denied.tools).toEqual([]);

    // When: tooling entries are requested.
    const withTooling = buildMcpListResult({
      defaultAllowlist: [],
      commandEntries,
      toolingEntries,
      tooling: true,
    });

    // Then: tooling entries are listed with tooling provenance.
    expect(withTooling.tools).toEqual([{ id: "tool:x", summary: "x", source: "tooling" }]);

    // When: tooling entries are not requested.
    const withoutTooling = buildMcpListResult({
      defaultAllowlist: [],
      commandEntries,
      toolingEntries,
      tooling: false,
    });

    // Then: tooling entries are absent.
    expect(withoutTooling.tools).toEqual([]);

    // When: an id is both defaulted and explicitly allowed.
    const combined = buildMcpListResult({
      defaultAllowlist: ["app:info"],
      commandEntries,
      allow: ["app:info"],
    });

    // Then: provenance includes both parts in stable order.
    expect(combined.tools).toEqual([{ id: "app:info", summary: "Show app info", source: "default+allow" }]);
  });

  test("emits schema-valid results and supports arbitrary generation", () => {
    // Given: a generated result and a built result.
    const arbitrary = Arbitrary.make(McpListResultSchema);
    const [sample] = FastCheck.sample(arbitrary, { numRuns: 1, seed: 398 });
    const result = buildMcpListResult({
      defaultAllowlist: ["app:info"],
      commandEntries: [{ spec: { id: "app:info", summary: "Show app info" } }],
    });

    // When: both values cross the schema boundary.
    const decode = Schema.decodeUnknownSync(McpListResultSchema);

    // Then: the hand-built result decodes and Arbitrary.make stays usable.
    expect(decode(result)).toEqual(result);
    expect(decode(sample)).toEqual(sample);
  });
});

describe("renderMcpListResult", () => {
  test("renders a tab-separated plain fallback", () => {
    // Given: a result with one tool.
    const result = { tools: [{ id: "app:info", summary: "Show app info", source: "default" }] };

    // When: rendering without a decorated context.
    const output = renderMcpListResult(result);

    // Then: the output is stable, tab-separated text.
    expect(output).toBe("tool\tsource\tsummary\napp:info\tdefault\tShow app info");
  });

  test("renders a friendly empty plain message", () => {
    // Given: an empty result.
    const result = { tools: [] };

    // When: rendering without a decorated context.
    const output = renderMcpListResult(result);

    // Then: users get a friendly empty state.
    expect(output).toBe("(no MCP tools)");
  });
});
