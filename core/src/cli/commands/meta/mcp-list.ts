import { Schema } from "effect";

import { computeEffectiveAllowlist } from "../../../mcp/catalog.ts";
import { type RenderContext, isDecoratedContext } from "../../renderer-boundary.ts";
import { type SummaryDocument, formatSummary } from "../../renderer/summary.ts";

export const McpListToolSchema = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  source: Schema.String,
});

export const McpListResultSchema = Schema.Struct({
  tools: Schema.Array(McpListToolSchema),
});

export type McpListTool = typeof McpListToolSchema.Type;
export type McpListResult = typeof McpListResultSchema.Type;

interface McpListEntrySpec {
  readonly id: string;
  readonly summary: string;
  readonly description?: string | undefined;
}

interface McpListEntry {
  readonly spec: McpListEntrySpec;
}

export interface BuildMcpListResultInput {
  readonly defaultAllowlist: ReadonlyArray<string>;
  readonly commandEntries: ReadonlyArray<McpListEntry>;
  readonly toolingEntries?: ReadonlyArray<McpListEntry> | undefined;
  readonly allow?: ReadonlyArray<string> | undefined;
  readonly deny?: ReadonlyArray<string> | undefined;
  readonly tooling?: boolean | undefined;
}

const sourceFor = (id: string, input: BuildMcpListResultInput, toolingIds: ReadonlySet<string>): string => {
  const parts: string[] = [];
  if (input.defaultAllowlist.includes(id)) parts.push("default");
  if ((input.allow ?? []).includes(id)) parts.push("allow");
  if (toolingIds.has(id)) parts.push("tooling");
  return parts.join("+");
};

export const buildMcpListResult = (input: BuildMcpListResultInput): McpListResult => {
  const toolingEntries = input.tooling === true ? (input.toolingEntries ?? []) : [];
  const toolingIds = new Set(toolingEntries.map((entry) => entry.spec.id));
  const effective = computeEffectiveAllowlist({
    defaults: [...input.defaultAllowlist, ...toolingIds],
    allow: input.allow,
    deny: input.deny,
  });
  const toolsById = new Map<string, McpListTool>();

  for (const entry of [...input.commandEntries, ...toolingEntries]) {
    const id = entry.spec.id;
    if (effective.ids.has(id) && !toolsById.has(id)) {
      toolsById.set(id, { id, summary: entry.spec.summary, source: sourceFor(id, input, toolingIds) });
    }
  }

  return { tools: [...toolsById.values()].sort((left, right) => left.id.localeCompare(right.id)) };
};

const buildMcpListSummary = (result: McpListResult): SummaryDocument => {
  const rows = result.tools.map((tool) => ({
    label: tool.id,
    tone: "info" as const,
    value: tool.source,
    fields: [{ label: "summary", value: tool.summary }],
  }));
  return {
    title: "MCP TOOLS",
    tone: "info",
    sections: [
      {
        title: "tools",
        rows,
        ...(rows.length === 0 ? { notes: ["No MCP tools are allowed."] } : {}),
      },
    ],
    footer: `${result.tools.length} tools`,
  };
};

export const renderMcpListResult = (result: McpListResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx)) return formatSummary(buildMcpListSummary(result), { columns: ctx?.columns });
  if (result.tools.length === 0) return "(no MCP tools)";
  const rows = result.tools.map((tool) => `${tool.id}\t${tool.source}\t${tool.summary}`);
  return ["tool\tsource\tsummary", ...rows].join("\n");
};
