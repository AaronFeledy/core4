import { Schema } from "effect";

export const McpToolDescriptor = Schema.Struct({
  toolId: Schema.String.annotate({
    description: 'Canonical command id exposed as this tool (e.g. "app:info").',
  }),
  commandId: Schema.String.annotate({
    description: "The canonical command id the tool dispatches to (equal to toolId).",
  }),
  title: Schema.String.annotate({ description: "Human-readable tool title (the command summary)." }),
  description: Schema.String.annotate({
    description: "Longer tool description surfaced to the agent.",
  }),
  destructive: Schema.Boolean.annotate({
    description:
      "Whether the tool performs a destructive operation; only true when a destructive id is explicitly enabled via mcp.allow.",
  }),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: "JSON-Schema-shaped object derived from the command's flags/args.",
  }),
});
export type McpToolDescriptor = typeof McpToolDescriptor.Type;

/** The MCP tool catalog — the `lando mcp --list` output shape. */
export const McpCatalog = Schema.Struct({
  tools: Schema.Array(McpToolDescriptor).annotate({
    description: "Every tool the effective allowlist exposes, ordered by canonical id.",
  }),
});
export type McpCatalog = typeof McpCatalog.Type;

/** Options that shape catalog generation (the `--list` inputs). */
export const McpCatalogOptions = Schema.Struct({
  allow: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Additional canonical ids to allow beyond the defaults (--allow).",
  }),
  deny: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Canonical ids to deny; deny wins over allow (--deny).",
  }),
  tooling: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether to project tooling tasks as tools (--tooling).",
  }),
});
export type McpCatalogOptions = typeof McpCatalogOptions.Type;

/** Options for `McpService.serve` — how the stdio MCP server is launched. */
export const McpServeOptions = Schema.Struct({
  transport: Schema.Literal("stdio").annotate({
    description: "Transport; stdio only in v4.0 (streamable-HTTP is deferred).",
  }),
  allow: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Additional canonical ids to allow beyond the defaults (--allow).",
  }),
  deny: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Canonical ids to deny; deny wins over allow (--deny).",
  }),
  tooling: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether to project tooling tasks as tools (--tooling).",
  }),
  maxConcurrent: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0)))).annotate({
    description: "Cap on concurrent in-flight tool calls (default 4).",
  }),
  cwd: Schema.optionalKey(Schema.String).annotate({
    description: "Working directory used to resolve the app when a call omits a path.",
  }),
});
export type McpServeOptions = typeof McpServeOptions.Type;
