import { McpAllowlistConflictError } from "@lando/sdk/errors";

export const APP_CONFIG_MCP_UNSAFE_IDS: ReadonlySet<string> = new Set([
  "app:config",
  "app:config:edit",
  "app:config:set",
  "app:config:unset",
  "app:config:validate",
]);

export const MCP_ALLOWLIST_FORBIDDEN_IDS: ReadonlyArray<string> = [
  ...APP_CONFIG_MCP_UNSAFE_IDS,
  "app:destroy",
  "apps:poweroff",
  "meta:uninstall",
];

const FORBIDDEN_ID_SET = new Set(MCP_ALLOWLIST_FORBIDDEN_IDS);

/**
 * Ids MCP never exposes, whatever their provenance, descriptor, or explicit allowance.
 * Tether is an interactive-only foreground session; no programmatic entry may start it.
 */
export const MCP_NEVER_ALLOWED_IDS: ReadonlySet<string> = new Set(["app:remote:tether"]);

export const isMcpNeverAllowed = (id: string): boolean => MCP_NEVER_ALLOWED_IDS.has(id);

export const destructiveCommandVerbs: ReadonlySet<string> = new Set([
  "destroy",
  "remove",
  "uninstall",
  "prune",
  "gc",
  "reset",
  "restore",
  "rebuild",
  "poweroff",
]);

export const isAppConfigMcpUnsafeId = (id: string): boolean => APP_CONFIG_MCP_UNSAFE_IDS.has(id);

export const isMcpAllowlistForbidden = (id: string): boolean =>
  FORBIDDEN_ID_SET.has(id) || id.startsWith("meta:plugin:");

interface McpAllowlistSpecView {
  readonly id: string;
  readonly mcpAllowed?: boolean;
  readonly flags?: Readonly<Record<string, unknown>>;
}

export const isMcpDestructiveCommand = (spec: McpAllowlistSpecView): boolean =>
  isMcpAllowlistForbidden(spec.id) ||
  destructiveCommandVerbs.has(spec.id.slice(spec.id.lastIndexOf(":") + 1)) ||
  spec.flags?.yes !== undefined;

export const assertMcpAllowlistSafe = (spec: McpAllowlistSpecView): void => {
  if (spec.mcpAllowed === true && isMcpDestructiveCommand(spec)) {
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
    if (spec.mcpAllowed !== true || isMcpNeverAllowed(spec.id)) continue;
    assertMcpAllowlistSafe(spec);
    ids.add(spec.id);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
};

export const filterMcpDefaultAllowlist = (
  defaults: readonly string[],
  entries: readonly {
    readonly spec: McpAllowlistSpecView;
    readonly plugin?: { readonly name: string; readonly source: "bundled" | "external" };
  }[],
): readonly string[] =>
  entries
    .filter(
      (entry) =>
        defaults.includes(entry.spec.id) &&
        !isMcpNeverAllowed(entry.spec.id) &&
        (entry.plugin === undefined ||
          (entry.plugin.source === "bundled" &&
            entry.spec.mcpAllowed === true &&
            !isMcpDestructiveCommand(entry.spec))),
    )
    .map((entry) => entry.spec.id);
