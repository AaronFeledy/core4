// Temporary core-private bridge between the §6.11 `ServiceType` contract and
// today's monolithic plan production. The catalog still carries its verbatim
// plan body under the private `__legacyToServicePlan` key; the §6.11.0
// composition pipeline (US-359) replaces this bridge with base + feature
// composition. Delete this module in US-359.
import type { PlanMetadata, ProviderId, ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import type { ServiceType, ServiceTypeHostFacts } from "@lando/sdk/services";

/** Input the catalog's legacy plan bodies consume (mirrors the removed SDK `ServiceTypePlanInput`). */
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

interface LegacyServiceTypeCarrier {
  readonly __legacyToServicePlan: (input: LegacyServicePlanInput) => ServicePlan;
}

const hasLegacyBridge = (serviceType: ServiceType): serviceType is ServiceType & LegacyServiceTypeCarrier =>
  "__legacyToServicePlan" in serviceType &&
  typeof (serviceType as LegacyServiceTypeCarrier).__legacyToServicePlan === "function";

/**
 * Produce a `ServicePlan` from a service type via its private legacy bridge.
 * Fails loud when a service type omits `__legacyToServicePlan` — until US-359
 * wires the composition pipeline, every bundled type MUST carry it.
 */
export const legacyServicePlan = (serviceType: ServiceType, input: LegacyServicePlanInput): ServicePlan => {
  if (!hasLegacyBridge(serviceType)) {
    throw new Error(
      `Service type "${serviceType.id}" does not carry the legacy plan bridge (__legacyToServicePlan); the §6.11 composition pipeline that resolves it has not landed yet.`,
    );
  }
  return serviceType.__legacyToServicePlan(input);
};
