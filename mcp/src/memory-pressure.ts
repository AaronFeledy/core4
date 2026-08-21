/**
 * Bun 1.4 `process.on("memoryPressure")` handling for the long-lived MCP server.
 *
 * The listener lives in `@lando/mcp` (the retained-runtime owner), not in
 * one-shot CLI commands. The hook is deliberately conservative: drop caches
 * and close idle sockets only. Do not abort in-flight tool calls, do not
 * `process.exit`, and do not clear `RedactionService` state.
 */
export type MemoryPressureLevel = "warning" | "critical";

export interface McpMemoryPressureHooks {
  /** Drop rebuildable caches (catalog, allowlist projections). */
  readonly dropCaches: () => void;
  /**
   * Close idle sockets and release idle transport buffers.
   * Must not close the live stdio session or in-flight request I/O.
   */
  readonly closeIdleSockets: () => void;
}

/**
 * `McpService.handleMemoryPressure(level)` implementation.
 *
 * MCP currently has no idle socket pool. `closeIdleSockets` is therefore a
 * documented no-op unless a session registers idle-state cleanup (completed
 * request-id history, leftover transport buffers). Catalog / allowlist caches
 * are always safe to drop.
 */
export const handleMemoryPressure = (_level: MemoryPressureLevel, hooks: McpMemoryPressureHooks): void => {
  hooks.dropCaches();
  hooks.closeIdleSockets();
};

export const attachMemoryPressureListener = (handler: (level: MemoryPressureLevel) => void): (() => void) => {
  const listener = (level: MemoryPressureLevel): void => {
    handler(level);
  };
  process.on("memoryPressure", listener);
  return () => {
    process.off("memoryPressure", listener);
  };
};
