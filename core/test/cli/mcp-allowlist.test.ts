import { describe, expect, test } from "bun:test";

import { McpAllowlistConflictError } from "@lando/sdk/errors";

import type { LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import compiledCommands from "../../src/cli/oclif/compiled-commands.ts";
import { MCP_DEFAULT_ALLOWLIST } from "../../src/cli/oclif/generated/mcp-allowlist.ts";
import {
  MCP_ALLOWLIST_FORBIDDEN_IDS,
  assertMcpAllowlistSafe,
  computeMcpDefaultAllowlist,
  isMcpAllowlistForbidden,
} from "../../src/cli/oclif/mcp-allowlist.ts";

const EXPECTED_DEFAULT_ALLOWLIST = [
  "app:exec",
  "app:info",
  "app:logs",
  "app:restart",
  "app:start",
  "app:stop",
  "apps:list",
  "apps:scratch:list",
  "meta:doctor",
  "meta:recipes:describe",
  "meta:recipes:list",
  "meta:recipes:validate",
  "meta:version",
];

const specFor = (id: string): LandoCommandSpec => {
  const commandClass = (compiledCommands as Record<string, { readonly landoSpec?: LandoCommandSpec }>)[id];
  const spec = commandClass?.landoSpec;
  if (spec === undefined) throw new Error(`No landoSpec for command id ${id}`);
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
  } => ({ id, mcpAllowed });

  test("rejects a destructive built-in that self-allows", () => {
    expect(() => assertMcpAllowlistSafe(makeSpec("app:destroy", true))).toThrow(McpAllowlistConflictError);
    expect(() => assertMcpAllowlistSafe(makeSpec("meta:plugin:add", true))).toThrow(
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
  test("derives exactly the shipped opt-ins, sorted", () => {
    const specs = Object.values(compiledCommands)
      .map((commandClass) => (commandClass as { readonly landoSpec?: LandoCommandSpec }).landoSpec)
      .filter((spec): spec is LandoCommandSpec => spec !== undefined);
    expect(computeMcpDefaultAllowlist(specs)).toEqual(EXPECTED_DEFAULT_ALLOWLIST);
  });

  test("the generated cache matches the live derivation (no drift)", () => {
    const specs = Object.values(compiledCommands)
      .map((commandClass) => (commandClass as { readonly landoSpec?: LandoCommandSpec }).landoSpec)
      .filter((spec): spec is LandoCommandSpec => spec !== undefined);
    expect([...MCP_DEFAULT_ALLOWLIST]).toEqual(computeMcpDefaultAllowlist(specs));
  });

  test("every opt-in command actually declares mcpAllowed", () => {
    for (const id of EXPECTED_DEFAULT_ALLOWLIST) {
      expect(specFor(id).mcpAllowed).toBe(true);
    }
  });

  test("does not expose the app config umbrella until MCP can project read-only verbs", () => {
    expect(specFor("app:config").mcpAllowed).toBeUndefined();
    expect(MCP_DEFAULT_ALLOWLIST).not.toContain("app:config");
  });

  test("no destructive id is in the default allowlist", () => {
    for (const id of MCP_DEFAULT_ALLOWLIST) {
      expect(isMcpAllowlistForbidden(id)).toBe(false);
    }
  });
});
