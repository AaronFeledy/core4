import { McpAllowlistConflictError } from "@lando/sdk/errors";

export const MCP_ALLOWLIST_FORBIDDEN_IDS: ReadonlyArray<string> = [
  "app:destroy",
  "apps:poweroff",
  "meta:uninstall",
];

const FORBIDDEN_ID_SET = new Set(MCP_ALLOWLIST_FORBIDDEN_IDS);

export const isMcpAllowlistForbidden = (id: string): boolean =>
  FORBIDDEN_ID_SET.has(id) || id.startsWith("meta:plugin:");

interface McpAllowlistSpecView {
  readonly id: string;
  readonly mcpAllowed?: boolean;
}

export const assertMcpAllowlistSafe = (spec: McpAllowlistSpecView): void => {
  if (spec.mcpAllowed === true && isMcpAllowlistForbidden(spec.id)) {
    throw new McpAllowlistConflictError({
      message: `Command ${spec.id} is a destructive surface and must not set mcpAllowed: true.`,
      commandId: spec.id,
      remediation:
        "Remove `mcpAllowed: true` from this command. Destructive commands are exposed to MCP only via explicit `mcp.allow` config, never by self-allowing.",
    });
  }
};

export const computeMcpDefaultAllowlist = (
  specs: ReadonlyArray<McpAllowlistSpecView>,
): ReadonlyArray<string> => {
  const ids = new Set<string>();
  for (const spec of specs) {
    if (spec.mcpAllowed !== true) continue;
    assertMcpAllowlistSafe(spec);
    ids.add(spec.id);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
};
