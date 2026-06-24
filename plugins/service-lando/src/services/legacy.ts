// Temporary legacy service-plan bridge until the composition engine and catalog
// migration replace `__legacyToServicePlan` with base + feature `resolve()`.
import { Effect, Schema } from "effect";

import type { PlanMetadata, ProviderId, ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import type {
  ServiceType,
  ServiceTypeHostFacts,
  ServiceTypeInput,
  ServiceTypeResolution,
} from "@lando/sdk/services";

/**
 * Input shape the catalog's verbatim plan bodies consume. Mirrors the removed
 * SDK `ServiceTypePlanInput`; kept catalog-private until the composition engine
 * lands and the legacy bodies are deleted.
 */
export interface LegacyServicePlanInput {
  readonly name: string;
  readonly service: ServiceConfig;
  readonly appRoot: string;
  readonly appName?: string;
  readonly provider?: ProviderId;
  readonly primary?: boolean;
  readonly metadata: typeof PlanMetadata.Encoded;
  readonly host?: ServiceTypeHostFacts | undefined;
}

/**
 * A `ServiceType` that still carries its pre-composition plan body under the
 * core/plugin-private `__legacyToServicePlan` key. Core's planner consumes this
 * via the core-private legacy bridge until the composition pipeline lands.
 */
export interface LegacyServiceType extends ServiceType {
  readonly __legacyToServicePlan: (input: LegacyServicePlanInput) => ServicePlan;
}

/**
 * Permissive placeholder schema for every legacy catalog type. Real per-type
 * schemas land with the base/feature catalog migration.
 */
export const DEFAULT_SERVICE_TYPE_SCHEMA: Schema.Schema<unknown> = Schema.Unknown;

/**
 * Minimal `resolve()` for a legacy catalog type: it normalizes to the authored
 * service config and declares no features. The real plan is still produced by
 * `__legacyToServicePlan` until composition owns plans; this satisfies the
 * contract shape (declared base + resolution, never a hand-built plan).
 */
export const legacyResolve =
  (base: "l337" | "lando"): ((input: ServiceTypeInput) => Effect.Effect<ServiceTypeResolution, never>) =>
  (input) =>
    Effect.succeed({ base, normalizedConfig: input.service, features: [] });

/** Options for assembling a legacy catalog service type. */
export interface DefineLegacyServiceTypeOptions {
  readonly id: string;
  readonly name?: string;
  readonly base?: "l337" | "lando";
  readonly toServicePlan: (input: LegacyServicePlanInput) => ServicePlan;
}

/**
 * Assemble a `LegacyServiceType` from an existing plan body. `base` defaults to
 * `"lando"` until per-type base metadata is authored; `name` defaults to the id.
 */
export const defineLegacyServiceType = (options: DefineLegacyServiceTypeOptions): LegacyServiceType => ({
  id: options.id,
  name: options.name ?? options.id,
  base: options.base ?? "lando",
  schema: DEFAULT_SERVICE_TYPE_SCHEMA,
  resolve: legacyResolve(options.base ?? "lando"),
  __legacyToServicePlan: options.toServicePlan,
});
