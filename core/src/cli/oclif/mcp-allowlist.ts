import { McpAllowlistConflictError } from "@lando/sdk/errors";

// Pure, cold-start-safe helpers for the MCP default allowlist (§8.3, §10.14).
// The default set of canonical command ids `lando mcp` exposes as tools is
// generated from every LandoCommandSpec with `mcpAllowed: true`. Destructive
// surfaces are never default-allowed: a destructive built-in that declares
// `mcpAllowed: true` is rejected at registration with McpAllowlistConflictError.

/**
 * Canonical ids that must never appear in the default MCP allowlist. These are
 * exposed to an agent only via explicit `mcp.allow` config, never by a command
 * self-allowing. Plugin mutations (`meta:plugin:*`) are additionally forbidden
 * by prefix (see {@link isMcpAllowlistForbidden}).
 */
export const MCP_ALLOWLIST_FORBIDDEN_IDS: ReadonlyArray<string> = [
  "app:destroy",
  "apps:poweroff",
  "meta:uninstall",
];

const FORBIDDEN_ID_SET = new Set(MCP_ALLOWLIST_FORBIDDEN_IDS);

/** Whether a canonical command id is a destructive surface barred from the default allowlist. */
export const isMcpAllowlistForbidden = (id: string): boolean =>
  FORBIDDEN_ID_SET.has(id) || id.startsWith("meta:plugin:");

interface McpAllowlistSpecView {
  readonly id: string;
  readonly mcpAllowed?: boolean;
}

/**
 * Reject a command spec that self-allows into the MCP catalog while being a
 * destructive surface. Called at registration alongside the other structural
 * command-spec checks, and by the allowlist generator.
 */
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

/**
 * Derive the default MCP allowlist from a set of command specs: every spec with
 * `mcpAllowed: true`, sorted and de-duplicated. Throws if any opt-in is a
 * forbidden destructive surface.
 */
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
