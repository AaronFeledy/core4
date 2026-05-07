/**
 * v4 service Effect Schemas.
 *
 * - `ServiceConfig` — input shape.
 * - `ServicePlan` — planned shape that crosses to providers.
 * - `ServiceInfo` — runtime info returned by `lando info`.
 *
 * The canonical schemas live in `@lando/sdk/schema`. Re-exported here for
 * intra-core ergonomics.
 */
export { ServiceConfig, ServicePlan, ServiceInfo } from "@lando/sdk/schema";
