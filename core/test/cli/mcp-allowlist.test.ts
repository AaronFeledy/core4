import { describe, expect, test } from "bun:test";

import { McpAllowlistConflictError } from "@lando/sdk/errors";

import {
  MCP_ALLOWLIST_FORBIDDEN_IDS,
  assertMcpAllowlistSafe,
  computeMcpDefaultAllowlist,
  isMcpAllowlistForbidden,
} from "@lando/mcp/allowlist";
import { buildCatalog, computeEffectiveAllowlist } from "@lando/mcp/catalog";
import { MCP_DEFAULT_ALLOWLIST } from "@lando/mcp/generated-allowlist";
import type { McpCommandSpec } from "@lando/mcp/registry";
import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { mcpRegistryFromBuiltIns } from "../../src/cli/commands/meta/mcp.ts";
import { BUNDLED_COMMAND_DESCRIPTORS } from "../../src/cli/generated/bundled-command-descriptors.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-base.ts";

const EXPECTED_DEFAULT_ALLOWLIST = [
  "app:config:get",
  "app:config:view",
  "app:exec",
  "app:info",
  "app:logs",
  "app:restart",
  "app:start",
  "app:stop",
  "apps:list",
  "apps:scratch:list",
  "db:snapshots",
  "meta:doctor",
  "meta:recipes:describe",
  "meta:recipes:list",
  "meta:recipes:validate",
  "meta:version",
];

const specFor = (id: string): LandoCommandSpec => {
  const spec = builtInCommandEntries.find((entry) => entry.spec.id === id)?.spec;
  if (spec === undefined) throw new Error(`No landoSpec for command id ${id}`);
  return spec;
};

const mcpSpecFor = (id: string): Pick<McpCommandSpec, "id" | "mcpAllowed"> => {
  const spec =
    mcpRegistryFromBuiltIns(builtInCommandEntries).commandEntries.find((entry) => entry.spec.id === id)
      ?.spec ?? BUNDLED_COMMAND_DESCRIPTORS.find((entry) => entry.id === id);
  if (spec === undefined) throw new Error(`No MCP registry spec for tool id ${id}`);
  return spec;
};

describe("MCP allowlist forbidden-id guard", () => {
  test("flags the explicitly destructive ids", () => {
    for (const id of ["app:destroy", "apps:poweroff", "meta:uninstall"]) {
      expect(isMcpAllowlistForbidden(id)).toBe(true);
      expect(MCP_ALLOWLIST_FORBIDDEN_IDS).toContain(id);
    }
  });

  test("flags every plugin mutation id", () => {
    for (const id of ["meta:plugin:add", "meta:plugin:remove", "meta:plugin:trust"]) {
      expect(isMcpAllowlistForbidden(id)).toBe(true);
    }
  });

  test("does not flag read-only / lateral ids", () => {
    for (const id of ["app:info", "app:logs", "apps:list", "meta:version"]) {
      expect(isMcpAllowlistForbidden(id)).toBe(false);
    }
  });
});

describe("assertMcpAllowlistSafe", () => {
  const makeSpec = (
    id: string,
    mcpAllowed: boolean | undefined,
  ): Pick<LandoCommandSpec, "id"> & {
    readonly mcpAllowed?: boolean;
  } => {
    if (mcpAllowed === undefined) return { id };
    return { id, mcpAllowed };
  };

  test("rejects a destructive built-in that self-allows", () => {
    expect(() => assertMcpAllowlistSafe(makeSpec("app:destroy", true))).toThrow(McpAllowlistConflictError);
    expect(() => assertMcpAllowlistSafe(makeSpec("meta:plugin:add", true))).toThrow(
      McpAllowlistConflictError,
    );
  });

  test("rejects app config write-capable variants that self-allow", () => {
    expect(() => assertMcpAllowlistSafe(makeSpec("app:config:set", true))).toThrow(McpAllowlistConflictError);
  });

  test("rejects a self-allowed app config umbrella before MCP projection replacement", () => {
    expect(() => mcpRegistryFromBuiltIns([{ spec: { ...specFor("app:config"), mcpAllowed: true } }])).toThrow(
      McpAllowlistConflictError,
    );
  });

  test("allows a destructive command that does not self-allow", () => {
    expect(() => assertMcpAllowlistSafe(makeSpec("app:destroy", false))).not.toThrow();
    expect(() => assertMcpAllowlistSafe(makeSpec("app:destroy", undefined))).not.toThrow();
  });

  test("allows a safe command that self-allows", () => {
    expect(() => assertMcpAllowlistSafe(makeSpec("app:info", true))).not.toThrow();
  });
});

describe("MCP default allowlist derivation", () => {
  test.each(["meta:global:disable", "meta:global:reconcile"])(
    "explicitly allowed %s reports destructive cleanup with invocation-only acknowledgement",
    (id) => {
      const registry = mcpRegistryFromBuiltIns(builtInCommandEntries);
      const catalog = buildCatalog({
        commandEntries: registry.commandEntries,
        effective: computeEffectiveAllowlist({ defaults: MCP_DEFAULT_ALLOWLIST, allow: [id] }),
      });
      expect(MCP_DEFAULT_ALLOWLIST).not.toContain(id);
      expect(catalog.tools.find((tool) => tool.commandId === id)).toMatchObject({
        destructive: true,
        inputSchema: {
          properties: {
            flags: {
              properties: { "allow-disruption": { type: "boolean" } },
            },
          },
        },
      });
      expect(specFor(id).flags?.yes).toBeUndefined();
      expect(() => assertMcpAllowlistSafe({ ...specFor(id), mcpAllowed: true })).toThrow(
        McpAllowlistConflictError,
      );
    },
  );

  test("derives exactly the shipped opt-ins, sorted", () => {
    const specs = [
      ...mcpRegistryFromBuiltIns(builtInCommandEntries).commandEntries.map((entry) => entry.spec),
      ...BUNDLED_COMMAND_DESCRIPTORS,
    ];
    expect([...computeMcpDefaultAllowlist(specs)]).toEqual([...EXPECTED_DEFAULT_ALLOWLIST]);
  });

  test("the generated cache matches the live derivation (no drift)", () => {
    const specs = [
      ...mcpRegistryFromBuiltIns(builtInCommandEntries).commandEntries.map((entry) => entry.spec),
      ...BUNDLED_COMMAND_DESCRIPTORS,
    ];
    expect([...MCP_DEFAULT_ALLOWLIST]).toEqual([...computeMcpDefaultAllowlist(specs)]);
  });

  test("every opt-in command actually declares mcpAllowed", () => {
    for (const id of EXPECTED_DEFAULT_ALLOWLIST) {
      expect(mcpSpecFor(id).mcpAllowed).toBe(true);
    }
  });

  test("projects read-only app config tools without exposing the unsafe umbrella", () => {
    expect(specFor("app:config").mcpAllowed).toBeUndefined();
    expect(mcpSpecFor("app:config:get").id).toBe("app:config:get");
    expect(mcpSpecFor("app:config:view").id).toBe("app:config:view");
    expect(MCP_DEFAULT_ALLOWLIST).not.toContain("app:config");
  });

  test("no destructive id is in the default allowlist", () => {
    for (const id of MCP_DEFAULT_ALLOWLIST) {
      expect(isMcpAllowlistForbidden(id)).toBe(false);
    }
  });
});
