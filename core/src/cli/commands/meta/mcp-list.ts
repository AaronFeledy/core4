import { Schema } from "effect";

import { isMcpDestructiveCommand } from "@lando/mcp/allowlist";
import { computeEffectiveAllowlist } from "@lando/mcp/catalog";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { type SummaryDocument, formatSummary } from "@lando/renderer/summary";
import { type RenderContext, isDecoratedContext, summaryPaintOptions } from "../../renderer-boundary";

export const McpListToolSchema = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  source: Schema.String,
  plugin: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      /** Authorization class: only bundled contributions inherit default allowance. */
      source: Schema.Literals(["bundled", "external"]),
      /** Discovery tier the selected plugin contribution came from. */
      provenance: Schema.optionalKey(Schema.Literals(["bundled", "system", "user", "app", "explicit"])),
    }),
  ),
  destructive: Schema.optionalKey(Schema.Boolean),
});

export const McpListResultSchema = Schema.Struct({
  tools: Schema.Array(McpListToolSchema),
  diagnostics: Schema.Array(
    Schema.Struct({
      _tag: Schema.String,
      message: Schema.String,
      remediation: Schema.optionalKey(Schema.String),
    }),
  ),
});

export type McpListTool = typeof McpListToolSchema.Type;
export type McpListResult = typeof McpListResultSchema.Type;

interface McpListEntrySpec {
  readonly id: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly flags?: Readonly<Record<string, unknown>>;
}

interface McpListEntry {
  readonly spec: McpListEntrySpec;
  readonly plugin?: McpCommandEntry["plugin"];
}

export interface BuildMcpListResultInput {
  readonly defaultAllowlist: ReadonlyArray<string>;
  readonly commandEntries: ReadonlyArray<McpListEntry>;
  readonly toolingEntries?: ReadonlyArray<McpListEntry> | undefined;
  readonly allow?: ReadonlyArray<string> | undefined;
  readonly deny?: ReadonlyArray<string> | undefined;
  readonly tooling?: boolean | undefined;
  readonly diagnostics?: McpListResult["diagnostics"];
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
      toolsById.set(id, {
        id,
        summary: entry.spec.summary,
        source: sourceFor(id, input, toolingIds),
        ...(entry.plugin === undefined
          ? {}
          : { plugin: entry.plugin, destructive: isMcpDestructiveCommand(entry.spec) }),
      });
    }
  }

  return {
    tools: [...toolsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: input.diagnostics ?? [],
  };
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
      ...(result.diagnostics.length === 0
        ? []
        : [
            {
              title: "diagnostics",
              rows: [],
              notes: result.diagnostics.map((diagnostic) => `${diagnostic._tag}: ${diagnostic.message}`),
            },
          ]),
    ],
    footer: `${result.tools.length} tools`,
  };
};

export const renderMcpListResult = (result: McpListResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx)) return formatSummary(buildMcpListSummary(result), summaryPaintOptions(ctx));
  const rows = result.tools.map((tool) => `${tool.id}\t${tool.source}\t${tool.summary}`);
  const tools = rows.length === 0 ? ["(no MCP tools)"] : ["tool\tsource\tsummary", ...rows];
  return [
    ...tools,
    ...result.diagnostics.map((diagnostic) => `${diagnostic._tag}: ${diagnostic.message}`),
  ].join("\n");
};
