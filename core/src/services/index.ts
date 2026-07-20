/**
 * `@lando/core/services` — every Effect Service tag in one place.
 *
 * Embedding hosts and plugin authors import service tags from here:
 *
 * ```ts
 * import { ConfigService, RuntimeProvider } from "@lando/core/services";
 * ```
 *
 * The canonical tag definitions live in `@lando/sdk/services`; this file
 * re-exports them so consumers don't need to depend on the SDK directly.
 *
 * NOTE: this is the public-API entry. The neighboring modules
 * (`./planner.ts`, `./feature.ts`, `./base/*`, `./schema.ts`) are core
 * implementation details for the v4 service planner — they are not part
 * of the public surface.
 */

export * from "@lando/sdk/services";

export { McpService, McpServiceLive, McpRuntimeConfig, DEFAULT_MCP_MAX_CONCURRENT } from "../mcp/service.ts";
export type { McpServiceShape, McpRuntimeConfigShape } from "../mcp/service.ts";
export { EventDeliveryMetrics } from "./event-service.ts";
export type { EventDeliveryMetricsSnapshot } from "./event-service.ts";
