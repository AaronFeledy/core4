import { Schema } from "effect";

export const McpToolDescriptor = Schema.Struct({
  toolId: Schema.String.annotations({
    description: 'Canonical command id exposed as this tool (e.g. "app:info").',
  }),
  commandId: Schema.String.annotations({
    description: "The canonical command id the tool dispatches to (equal to toolId).",
  }),
  title: Schema.String.annotations({ description: "Human-readable tool title (the command summary)." }),
  description: Schema.String.annotations({
    description: "Longer tool description surfaced to the agent.",
  }),
  destructive: Schema.Boolean.annotations({
    description:
      "Whether the tool performs a destructive operation; only true when a destructive id is explicitly enabled via mcp.allow.",
  }),
  inputSchema: Schema.Record({ key: Schema.String, value: Schema.Unknown }).annotations({
    description: "JSON-Schema-shaped object derived from the command's flags/args.",
  }),
});
export type McpToolDescriptor = typeof McpToolDescriptor.Type;

/** The MCP tool catalog — the `lando mcp --list` output shape. */
export const McpCatalog = Schema.Struct({
  tools: Schema.Array(McpToolDescriptor).annotations({
    description: "Every tool the effective allowlist exposes, ordered by canonical id.",
  }),
});
export type McpCatalog = typeof McpCatalog.Type;

/** Options that shape catalog generation (the `--list` inputs). */
export const McpCatalogOptions = Schema.Struct({
  allow: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Additional canonical ids to allow beyond the defaults (--allow).",
  }),
  deny: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Canonical ids to deny; deny wins over allow (--deny).",
  }),
  tooling: Schema.optional(Schema.Boolean).annotations({
    description: "Whether to project tooling tasks as tools (--tooling).",
  }),
});
export type McpCatalogOptions = typeof McpCatalogOptions.Type;

/** Options for `McpService.serve` — how the stdio MCP server is launched. */
export const McpServeOptions = Schema.Struct({
  transport: Schema.Literal("stdio").annotations({
    description: "Transport; stdio only in v4.0 (streamable-HTTP is deferred).",
  }),
  allow: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Additional canonical ids to allow beyond the defaults (--allow).",
  }),
  deny: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Canonical ids to deny; deny wins over allow (--deny).",
  }),
  tooling: Schema.optional(Schema.Boolean).annotations({
    description: "Whether to project tooling tasks as tools (--tooling).",
  }),
  maxConcurrent: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())).annotations({
    description: "Cap on concurrent in-flight tool calls (default 4).",
  }),
  cwd: Schema.optional(Schema.String).annotations({
    description: "Working directory used to resolve the app when a call omits a path.",
  }),
});
export type McpServeOptions = typeof McpServeOptions.Type;
