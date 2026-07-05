/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-mcp-allowlist.ts`.
 *
 * Source of truth: every `LandoCommandSpec` with `mcpAllowed: true`.
 *
 * This is deliberately a literal-data module with no command or Effect imports,
 * so a consumer can read the default MCP allowlist without pulling the compiled
 * CLI command graph into scope (a cold-start regression).
 */

export const MCP_DEFAULT_ALLOWLIST: ReadonlyArray<string> = [
  "app:config",
  "app:exec",
  "app:info",
  "app:logs",
  "app:restart",
  "app:start",
  "app:stop",
  "apps:list",
  "apps:scratch:list",
  "meta:doctor",
  "meta:version",
];
