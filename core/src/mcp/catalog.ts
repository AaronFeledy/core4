/**
 * MCP catalog generation.
 *
 * The catalog is the `lando mcp --list` shape: every tool the effective
 * allowlist exposes, projected from the canonical command registry. The
 * effective set is the generated default allowlist plus `allow`/`--allow`,
 * minus `deny`/`--deny` (deny wins over allow).
 */
import type { McpCatalog, McpCatalogOptions, McpToolDescriptor } from "@lando/sdk/schema";

import type { LandoCommandSpec } from "../cli/oclif/command-base.ts";
import { isMcpAllowlistForbidden } from "../cli/oclif/mcp-allowlist.ts";
import { type McpCommandEntry, deriveToolInputSchema } from "./registry.ts";

export interface EffectiveAllowlistInput {
  readonly defaults: ReadonlyArray<string>;
  readonly allow?: ReadonlyArray<string> | undefined;
  readonly deny?: ReadonlyArray<string> | undefined;
}

export interface EffectiveAllowlist {
  readonly ids: ReadonlySet<string>;
  /** Human-readable provenance for the effective set (defaults + config/flags). */
  readonly source: string;
}

/**
 * Compute the effective tool allowlist: defaults ∪ allow, minus deny. Deny wins
 * over allow, so an id in both is excluded.
 */
export const computeEffectiveAllowlist = (input: EffectiveAllowlistInput): EffectiveAllowlist => {
  const deny = new Set(input.deny ?? []);
  const ids = new Set<string>();
  for (const id of input.defaults) if (!deny.has(id)) ids.add(id);
  for (const id of input.allow ?? []) if (!deny.has(id)) ids.add(id);
  const parts = ["defaults"];
  if ((input.allow ?? []).length > 0) parts.push("allow");
  if (deny.size > 0) parts.push("deny");
  return { ids, source: parts.join("+") };
};

const toDescriptor = (spec: LandoCommandSpec): McpToolDescriptor => ({
  toolId: spec.id,
  commandId: spec.id,
  title: spec.summary,
  description: spec.description ?? spec.summary,
  destructive: isMcpAllowlistForbidden(spec.id),
  inputSchema: deriveToolInputSchema(spec),
});

export interface BuildCatalogInput {
  /** Command entries projected as tools (filtered by the effective allowlist). */
  readonly commandEntries: ReadonlyArray<McpCommandEntry>;
  /** Tooling-task entries projected as tools only when `options.tooling` is true. */
  readonly toolingEntries?: ReadonlyArray<McpCommandEntry> | undefined;
  readonly effective: EffectiveAllowlist;
  readonly options?: McpCatalogOptions | undefined;
}

/**
 * Build the MCP catalog. Command tools are the effective-allowlist members;
 * tooling tools are appended when `options.tooling` is effective. Tools are
 * sorted by canonical id.
 */
export const buildCatalog = (input: BuildCatalogInput): McpCatalog => {
  const tools: McpToolDescriptor[] = [];
  for (const entry of input.commandEntries) {
    if (input.effective.ids.has(entry.spec.id)) tools.push(toDescriptor(entry.spec));
  }
  if (input.options?.tooling === true) {
    for (const entry of input.toolingEntries ?? []) tools.push(toDescriptor(entry.spec));
  }
  tools.sort((left, right) => left.toolId.localeCompare(right.toolId));
  return { tools };
};
